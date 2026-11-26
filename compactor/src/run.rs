//! One run of the compactor: what it reads, what it marks to be rebuilt, what it writes
//! beside the feed index, and what it settles once the index is written (see `Compactor`).
//! The index itself is built in `build`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use evieverse_core::content::ContentMeta;
use evieverse_core::db::{Dialect, Queries, Value, places};
use evieverse_core::layout::{COMPACTOR_STATE_KEY, author_index, index_author};
use evieverse_core::log;
use evieverse_core::params;
use evieverse_core::pending::pending_images;
use evieverse_core::quarantine::expire_quarantine;
use evieverse_core::reposts::{repost_times, reposted_tags};
use evieverse_core::search::index_content;
use evieverse_core::stores::PublishedAd;
use evieverse_core::summary::{Summary, SummaryRef, summary_of};
use evieverse_core::time::{DAY, HOUR, MINUTE, utc_day};
use evieverse_core::util::map_limit;
use futures::future::{LocalBoxFuture, Shared};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::OnceCell;

use crate::accounts::{drop_avatars, purge_accounts, sweep_content};
use crate::activity::{idle_moderators, retire_moderator, start_counting};
use crate::apply::{apply_pending, max_keywords};
use crate::deps::Deps;
use crate::lease::{Lease, is_lease_lost};
use crate::rows::{BATCH, CONTENT_COLUMNS, ContentRow, Places, content_rows, values};

/// Meta files of queued content read at once, ahead of the indexes that need them.
pub(crate) const META_READS: usize = 64;

/// Indexes a run opens together: their heads are one round trip, and their manifests another.
const TAG_BATCH: usize = 200;

/// Things a run writes at once where each is one small write: a credit, a user's follows, a
/// post's hashtags.
const SMALL_WRITES: usize = 16;

/// The most images a post can have (MAX_POST_IMAGES of src/posts.ts): what a run deletes of a
/// post whose meta file it can't read.
const MAX_POST_IMAGES: i64 = 10;

/// What to rebuild first, of what a run does anyway.
#[derive(Debug, Clone, Copy, Default)]
pub struct RunOptions {
    /// Rebuild every day of every tag, and work out every hashtag's related hashtags again.
    pub all: bool,
    /// Also re-admit every content within retention from the database and the meta files,
    /// restoring summaries and publisher credits: after Redis lost data.
    pub rebuild: bool,
}

/// What a run did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RunResult {
    /// The tags it compacted, the ones that failed among them.
    pub tags: Vec<String>,
    /// The content it deleted.
    pub deleted: Vec<String>,
    /// Whether it did nothing, because another run held the lease.
    pub skipped: bool,
}

/// A row of `feed_queue` a run took: content whose entry in a tag's index it rebuilds.
#[derive(Debug, Clone)]
struct QueueRow {
    id: String,
    tag: String,
    /// Names the write that stamped the row: the run deletes the row only if it still holds it.
    token: String,
    /// When the row was stamped, by the node that wrote it.
    queued_at: i64,
    /// The content's creation time, which picks the UTC day holding its entry, unless a
    /// repost placed it in the tag (see `Placement`).
    created_at: i64,
}

/// A place in a reposter's own index that a run takes away: the reposter's account is gone
/// (see `mark_gone_reposters`).
struct GonePlace {
    id: String,
    tag: String,
}

/// A place of a repost that was removed, which a run takes away: a row of `repost_removals`
/// (see `apply_removals`).
#[derive(Debug, Clone)]
struct RemovedPlace {
    /// The row's id, which the run deletes it by once the place is gone.
    key: String,
    /// The content that was reposted.
    id: String,
    /// The index the repost placed it in: a hashtag it gave it, or the reposter's own.
    tag: String,
    /// When the repost was made: the day the content's entry in that index is in.
    reposted_at: i64,
}

/// A row of `tag_moderation` a run applies.
struct Decision {
    id: String,
    tag: String,
    removed: bool,
    /// Names the decision: a later one about the same content and hashtag isn't the one this
    /// run applied.
    decided_at: i64,
}

/// Content set for deletion, with the tags whose compaction must succeed before it is deleted.
struct Deletion {
    id: String,
    created_at: i64,
    /// When it was reposted: its summary is under those days too, and goes from them with it.
    reposted_at: Vec<i64>,
    tags: Vec<String>,
}

/// A piece of content to mark the days of (see `mark_content`).
struct Marked {
    id: String,
    user_id: String,
    created_at: i64,
}

/// How far the compactor's runs have got, which is all it keeps from one run to the next: in
/// the hot store, under `COMPACTOR_STATE_KEY`. A run reads it as it starts (none there counts
/// as nothing applied yet), writes it once its tags are compacted, and again once it has
/// deleted what is past retention, which it does once a UTC day.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Likes and profile changes before this instant have been applied.
    #[serde(default)]
    through: i64,
    /// Hashtag counts (`tag_pairs`) made before this instant are in the related hashtags
    /// Redis holds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    related_through: Option<i64>,
    /// Summaries of UTC days before this one have been deleted, and inboxes were trimmed to
    /// their retention on the day that was done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summaries_purged_before: Option<i64>,
}

/// What to rebuild for one tag in a run.
#[derive(Debug, Clone, Default)]
pub(crate) struct TagWork {
    pub(crate) days: IndexSet<i64>,
    /// Per day, content to reconsider if the day doesn't hold it: an earlier compaction
    /// trimmed it (or Redis lost it).
    pub(crate) readmit: IndexMap<i64, IndexSet<String>>,
    /// Per day, content whose entry is rebuilt from the database and its meta file whether the
    /// day holds it or not, and dropped if it no longer carries the tag: the content of the
    /// feed queue's rows.
    pub(crate) recheck: IndexMap<i64, IndexSet<String>>,
    /// Rebuild every day (`--all`).
    pub(crate) all: bool,
}

/// What a run is to rebuild, by tag.
#[derive(Default)]
pub(crate) struct Work(RefCell<IndexMap<String, TagWork>>);

impl Work {
    fn of<T>(&self, tag: &str, change: impl FnOnce(&mut TagWork) -> T) -> T {
        change(self.0.borrow_mut().entry(tag.to_owned()).or_default())
    }

    /// Has the tag's index planned, whatever else is marked under it.
    fn touch(&self, tag: &str) {
        self.of(tag, |_| ());
    }

    /// Has every day of the tag rebuilt.
    fn all(&self, tag: &str) {
        self.of(tag, |work| work.all = true);
    }

    /// Has a day of the tag rebuilt.
    fn day(&self, tag: &str, day: i64) {
        self.of(tag, |work| work.days.insert(day));
    }

    /// Has a day of the tag rebuilt, and the content's entry there with it.
    fn recheck(&self, tag: &str, day: i64, id: &str) {
        self.of(tag, |work| {
            work.days.insert(day);
            work.recheck.entry(day).or_default().insert(id.to_owned());
        });
    }

    /// Has a day of the tag rebuilt, with the content reconsidered if the day doesn't hold it.
    fn readmit(&self, tag: &str, day: i64, id: &str) {
        self.of(tag, |work| {
            work.days.insert(day);
            work.readmit.entry(day).or_default().insert(id.to_owned());
        });
    }

    /// The work, once everything is marked.
    fn taken(&self) -> IndexMap<String, TagWork> {
        self.0.take()
    }
}

/// A meta file as a run read it, or why it couldn't.
type MetaRead = Result<Option<Arc<ContentMeta>>, String>;

/// What became of the summaries one call had both tiers hold: what went wrong with each, or
/// nothing.
pub(crate) type Ensuring = Shared<LocalBoxFuture<'static, Rc<Vec<Option<String>>>>>;

/// One run: what a compactor works with, the run's lease, and what every tag of the run shares.
pub(crate) struct Run<'a> {
    pub(crate) deps: &'a Deps,
    pub(crate) lease: &'a Lease,
    /// The run's start, by the compactor's clock: the instant everything it does is as of.
    pub(crate) run_start: i64,
    /// Rebuilding from the database: a missing manifest or day index counts as empty instead
    /// of failing the tag.
    pub(crate) rebuild: bool,
    work: Work,
    /// Meta files read this run, so content in several tags is read once.
    metas: RefCell<HashMap<String, Rc<OnceCell<MetaRead>>>>,
    /// Summaries checked (and restored if missing) this run, so content in several tags is
    /// checked once: the call that checks each, and its place in what that call returns.
    pub(crate) ensured: RefCell<HashMap<String, (Ensuring, usize)>>,
    /// The places reposts gave content, read this run.
    pub(crate) places: Places,
    /// Tags whose head this run didn't swap: what waits on them waits for a later run.
    pub(crate) failed: RefCell<HashSet<String>>,
}

/// The values of one column of rows, which are texts.
fn strings(rows: &[evieverse_core::db::Row], column: &str) -> Result<Vec<String>> {
    rows.iter().map(|row| row.string(column)).collect()
}

impl<'a> Run<'a> {
    pub(crate) fn new(deps: &'a Deps, lease: &'a Lease, opts: RunOptions) -> Self {
        Self {
            deps,
            lease,
            run_start: deps.now(),
            rebuild: opts.rebuild,
            work: Work::default(),
            metas: RefCell::new(HashMap::new()),
            ensured: RefCell::new(HashMap::new()),
            places: Places::new(deps.db.clone()),
            failed: RefCell::new(HashSet::new()),
        }
    }

    /// UTC days an index keeps.
    pub(crate) fn retention_days(&self) -> i64 {
        let feed = &self.deps.config.feed;
        feed.tag_retention_days.min(feed.max_lookback_days)
    }

    /// The instant content has to be newer than, or reposted after, for an index to hold it.
    pub(crate) fn oldest(&self) -> i64 {
        self.run_start - self.retention_days() * DAY
    }

    /// How long superseded keys stay readable: as long as a node may still serve the head that
    /// named them from its cache, and a minute more for the requests that read it last. No
    /// feed session needs them longer: a cursor names no index, and each page reads the one
    /// its tag's head names by then.
    pub(crate) fn keep_ms(&self) -> i64 {
        self.deps.config.feed.head_cache_ms + MINUTE
    }

    /// How long what a run writes for a hashtag lasts unless the hashtag's head is swapped to it.
    pub(crate) fn provisional_ms(&self) -> i64 {
        self.keep_ms().max(HOUR)
    }

    /// The meta file of a piece of content, read once a run: whoever asks again is told what
    /// the first read came to, a failure too.
    pub(crate) async fn meta(&self, content_id: &str) -> Result<Option<Arc<ContentMeta>>> {
        let read = self.metas.borrow_mut().entry(content_id.to_owned()).or_default().clone();
        let meta = read
            .get_or_init(|| async {
                let meta = self.deps.content.get_meta(content_id).await;
                meta.map(|meta| meta.map(Arc::new)).map_err(|err| format!("{err:#}"))
            })
            .await;
        meta.clone().map_err(|failure| anyhow!(failure))
    }

    /// Has the run read a meta file as it was just written.
    fn set_meta(&self, content_id: &str, meta: ContentMeta) {
        let written = OnceCell::new_with(Some(Ok(Some(Arc::new(meta)))));
        self.metas.borrow_mut().insert(content_id.to_owned(), Rc::new(written));
    }

    /// Records that these tags weren't compacted: they keep their heads, and what waited on
    /// them waits for the next run.
    pub(crate) fn fail(&self, tags: &[String], err: &anyhow::Error) {
        self.failed.borrow_mut().extend(tags.iter().cloned());
        self.deps.log.error(json!({ "err": log::err(err), "tags": tags }), "compaction failed");
    }

    /// The run, from the queue it takes to what it deletes (see `Compactor`).
    pub(crate) async fn run(&self, opts: RunOptions) -> Result<RunResult> {
        let Deps {
            db,
            hot,
            content,
            summaries,
            comments,
            config,
            log,
            ..
        } = self.deps;
        let (run_start, lease) = (self.run_start, self.lease);
        let state: State = match hot.get(COMPACTOR_STATE_KEY).await? {
            Some(state) => evieverse_core::json::from_slice(&state)?,
            None => State::default(),
        };

        // The queue first, before the pending writes are applied: a write commits its rows in the queue with the write
        // itself, so every write whose rows are taken here is applied below, or was before, and every meta file read
        // from then on is at least as new as the rows taken. The same goes for the places of reposts, which a repost
        // commits with its rows.
        let taken = self.read_queue().await?;
        if opts.all {
            for tag in strings(&db.fetch("SELECT name FROM tags", &[]).await?, "name")? {
                self.work.all(&tag);
            }
        }
        // Before any place is read: the ones it finds count as not there for the rest of the run.
        let gone = self.mark_gone_reposters().await?;
        // The writes requests committed: this is what writes them to the stores, before anything below reads those.
        let applied = apply_pending(self.deps, lease, &self.places).await?;
        for (id, meta) in applied.metas {
            self.set_meta(&id, meta);
        }
        // The reposts that were removed: once the writes are applied, and before a place is read for anything below.
        let removals = self.read_removals().await?;
        // A post whose write couldn't be applied keeps its rows: the meta file they are to be rebuilt from isn't written
        // yet. So does one whose write waits for its video to be processed: it is in feeds once that is done.
        let queue: Vec<QueueRow> = taken
            .into_iter()
            .filter(|row| !applied.failed.contains(&row.id) && !applied.waiting.contains(&row.id))
            .collect();
        self.places.load(queue.iter().map(|row| &row.id)).await?;
        // Next, as they write meta files: everything below reads them as these left them.
        let unplaced = self.apply_removals(&removals).await?;
        let decisions = self.apply_decisions().await?;
        let unapplied = self.apply_reposts(&queue).await?;
        if opts.rebuild {
            self.mark_everything().await?;
        }
        self.mark_new_likes(state.through).await?;
        self.sync_changed_publishers(state.through).await?;
        self.sync_changed_following(state.through).await?;
        let related_through = self.sync_related_tags(state.related_through.unwrap_or(0), opts.all || opts.rebuild).await?;
        self.sync_ads().await?;
        self.mark_queue(&queue);
        self.mark_outlived(&queue).await?;
        self.expire_gone().await?;
        let deletions = self.mark_deletions(&removals).await?;
        self.prefetch(&queue).await?;

        let work = self.work.taken();
        let mut tags: Vec<String> = work.keys().cloned().collect();
        tags.sort_unstable();
        map_limit(tags.chunks(TAG_BATCH), self.deps.concurrency(), |batch| self.compact_batch(batch, &work)).await?;
        // Likes and profile changes up to this run's start are now applied. Saved before the work below, so a run killed
        // during it doesn't mark them all again.
        let min_day = utc_day(run_start) - self.retention_days() + 1;
        let mut next = State {
            through: run_start,
            related_through: Some(related_through),
            summaries_purged_before: state.summaries_purged_before,
        };
        lease.check().await?;
        hot.set(COMPACTOR_STATE_KEY, &serde_json::to_vec(&next)?, None).await?;

        // Everything below relies on the heads this run published still being the current ones.
        let failed = self.failed.take();
        // The rows of content that a repost's hashtags couldn't be written to stay for the next run.
        let settled: Vec<&QueueRow> = queue.iter().filter(|row| !unapplied.contains(&row.id)).collect();
        self.settle_queue(&settled, &failed).await?;
        self.settle_decisions(&decisions, &failed).await?;
        self.settle_gone_reposters(&gone, &failed).await?;
        self.settle_removals(&unplaced, &failed).await?;
        let mut deleted = Vec::new();
        for deletion in deletions {
            if deletion.tags.iter().any(|tag| failed.contains(tag)) {
                continue;
            }
            let id = deletion.id.as_str();
            lease.check().await?;
            // The post's comments, which only the content store lists by post: while the row is still there, so a run
            // that fails here finds them again.
            comments.remove_all(id).await?;
            // The files of the writes that were applied, kept for the links that were given to them (see
            // `apply_pending`): gone with the post, whatever time they had left.
            let kept = strings(
                &db.fetch("SELECT staged_key FROM staged_removals WHERE content_id = ?", params![id]).await?,
                "staged_key",
            )?;
            for staged in &kept {
                content.remove_staged(staged).await?;
            }
            if !kept.is_empty() {
                db.execute("DELETE FROM staged_removals WHERE content_id = ?", params![id]).await?;
            }
            // The files of its writes that were never applied, and never will be: while the rows that name them are
            // still there, for the same reason. And then the row, once every one of them is gone: a comment takes no
            // lock on its post, so one that read the post before it was set for deletion may commit its row, and the
            // file it staged, as late as this. The row is locked for the last look, which waits for such a commit and
            // lets no other begin. Nothing begins once the deletion is set, so the look is rarely made twice.
            //
            // How many images it has, for an image post of several, each a file of its own: as its meta file says, or
            // a write that a run stopped in the middle of (read here, while its row is there). With no meta file to go
            // by, as many as a post can have.
            let said = match self.meta(id).await {
                Ok(meta) => meta
                    .and_then(|meta| meta.images.as_ref().map(Vec::len))
                    .map_or(1, |images| i64::try_from(images).unwrap_or(MAX_POST_IMAGES)),
                Err(_) => MAX_POST_IMAGES,
            };
            let images = said.max(pending_images(&mut &*db, id).await?);
            const STAGED: &str = "SELECT staged_key FROM pending_writes WHERE content_id = ? AND staged_key IS NOT NULL";
            let mut removed: HashSet<String> = HashSet::new();
            loop {
                for staged in strings(&db.fetch(STAGED, params![id]).await?, "staged_key")? {
                    if removed.contains(&staged) {
                        continue;
                    }
                    content.remove_staged(&staged).await?;
                    removed.insert(staged);
                }
                let mut tx = db.begin().await?;
                // SQLite runs one transaction at a time, and has no rows to lock.
                if db.dialect() != Dialect::Sqlite {
                    tx.fetch("SELECT id FROM content WHERE id = ? FOR UPDATE", params![id]).await?;
                }
                if strings(&tx.fetch(STAGED, params![id]).await?, "staged_key")?
                    .iter()
                    .any(|staged| !removed.contains(staged))
                {
                    tx.commit().await?;
                    continue;
                }
                // Likes, feed_queue rows, pending writes and the places of reposts cascade, and so do the rows of the
                // comments that waited in a queue.
                tx.execute("DELETE FROM content WHERE id = ? AND delete_requested_at IS NOT NULL", params![id])
                    .await?;
                tx.commit().await?;
                break;
            }
            summaries
                .remove(&[SummaryRef {
                    content_id: deletion.id.clone(),
                    created_at: deletion.created_at,
                    reposted_at: deletion.reposted_at,
                }])
                .await?;
            content.remove(id, images).await?;
            // What the server made of its video, every version there is: the poster and the stream, and whatever the
            // video worker had written of one it never finished.
            content.remove_media(id, None).await?;
            deleted.push(deletion.id);
        }
        self.settle_accounts().await?;
        self.retire_moderators().await?;

        // Once a UTC day, what is past its retention goes: inbox messages and notices, the quarantined files a year
        // past their report, then summaries.
        if state.summaries_purged_before != Some(min_day) {
            lease.check().await?;
            let expired = db
                .execute("DELETE FROM inbox WHERE created_at < ?", params![run_start - config.inbox.retention_days * DAY])
                .await?;
            if expired > 0 {
                log.info(json!({ "messages": expired }), "deleted inbox messages past retention");
            }
            // The quarantined files whose time after their report is over, where the server has a quarantine. One that
            // fails is tomorrow's, and stops nothing here.
            if let Err(err) = expire_quarantine(db, config, run_start, log).await {
                log.error(
                    json!({ "err": log::err(&err) }),
                    "could not delete the quarantined files whose time is over; it is tried again tomorrow",
                );
            }
            let purged = summaries.purge_before(min_day).await?;
            if !purged.is_empty() {
                log.info(json!({ "days": purged.len() }), "deleted summaries past retention");
            }
            lease.check().await?;
            next.summaries_purged_before = Some(min_day);
            hot.set(COMPACTOR_STATE_KEY, &serde_json::to_vec(&next)?, None).await?;
        }

        if !tags.is_empty() || !deleted.is_empty() {
            // How long the oldest write this run took had waited, by the clock of the node that queued it: what feeds
            // lag by.
            let oldest = queue.iter().map(|row| row.queued_at).fold(run_start, i64::min);
            log.info(
                json!({ "tags": tags.len(), "deleted": deleted.len(), "queued": queue.len(), "lagMs": run_start - oldest }),
                "compacted the feed index",
            );
        }
        Ok(RunResult { tags, deleted, skipped: false })
    }

    /// Finishes deleting the accounts that were closed (see `accounts`): sets for deletion the
    /// content of theirs that a request left unmarked, deletes what the content store holds
    /// of their avatars, and deletes the rows of those with no content left, which the
    /// deletions above may just have been. The rest wait for a later run, and so does one
    /// whose avatar the store kept.
    async fn settle_accounts(&self) -> Result<()> {
        let Deps { db, log, .. } = self.deps;
        let closed = strings(&db.fetch("SELECT id FROM users WHERE deleted_at IS NOT NULL", &[]).await?, "id")?;
        if closed.is_empty() {
            return Ok(());
        }
        for id in &closed {
            self.lease.check().await?;
            if let Err(err) = sweep_content(self.deps, id).await {
                log.error(
                    json!({ "err": log::err(&err), "userId": id }),
                    "could not set the content of a deleted account for deletion",
                );
            }
        }
        self.lease.check().await?;
        let cleared = drop_avatars(self.deps, &closed).await;
        self.lease.check().await?;
        let purged = purge_accounts(db, &cleared).await?;
        if !purged.is_empty() {
            log.info(json!({ "accounts": purged.len() }), "deleted accounts");
        }
        Ok(())
    }

    /// Ends the time of the hashtags' moderators who did nothing as one on their hashtag for
    /// `tagging.moderatorInactiveDays` (see `activity`), and tells each. Up to BATCH of them a
    /// run, longest idle first; the rest wait for the next, and so does one that fails.
    ///
    /// First it starts counting the moderators of whom nothing is known: the rows from before
    /// the server kept when a moderator last did anything are counted from this run, whatever
    /// the setting says, so that turning it on later finds them counted since then. A failure
    /// is logged and left for the next run, as nothing else a run does depends on it.
    async fn retire_moderators(&self) -> Result<()> {
        let Deps { db, log, config, .. } = self.deps;
        let days = config.tagging.moderator_inactive_days;
        let retiring = async {
            self.lease.check().await?;
            let started = start_counting(db, self.run_start).await?;
            if started > 0 {
                log.info(
                    json!({ "moderators": started }),
                    "started counting the time since hashtags' moderators last did anything, for those it wasn't known of",
                );
            }
            // 0: no moderator's time ends this way.
            if days == 0 {
                return Ok(());
            }
            let before = self.run_start - days * DAY;
            for moderator in idle_moderators(db, before, BATCH).await? {
                self.lease.check().await?;
                if let Err(err) = retire_moderator(db, &self.deps.content, log, self.deps.now(), &moderator, before).await {
                    log.error(
                        json!({ "err": log::err(&err), "tag": moderator.tag, "userId": moderator.user_id }),
                        "could not end an idle moderator's time on a hashtag",
                    );
                }
            }
            Ok(())
        }
        .await;
        match retiring {
            Err(err) if !is_lease_lost(&err) => {
                log.error(
                    json!({ "err": log::err(&err) }),
                    "could not end the time of the hashtags' idle moderators; the next run tries again",
                );
                Ok(())
            }
            outcome => outcome,
        }
    }

    /// What ends a select from `content` that keeps the content young enough for an index, or
    /// reposted since: it is then in an index, however old it is itself. Takes the oldest
    /// instant twice.
    const WITHIN_RETENTION: &'static str = "(content.created_at > ? OR EXISTS \
         (SELECT reposts.content_id FROM reposts WHERE reposts.content_id = content.id AND reposts.created_at > ?))";

    /// The content of rows of `id`, `user_id` and `created_at`.
    fn marked(rows: &[evieverse_core::db::Row]) -> Result<Vec<Marked>> {
        rows.iter()
            .map(|row| {
                Ok(Marked {
                    id: row.string("id")?,
                    user_id: row.string("user_id")?,
                    created_at: row.i64("created_at")?,
                })
            })
            .collect()
    }

    /// `--rebuild`: every content within retention is re-admitted under its tags and its
    /// publisher's own index, and where reposts placed it, and every publisher credit and
    /// every user's follows rewritten. Content older than that which was reposted within it is
    /// still in the indexes the repost put it in.
    async fn mark_everything(&self) -> Result<()> {
        let db = &self.deps.db;
        let oldest = self.oldest();
        let rows = db
            .fetch(
                &format!(
                    "SELECT content.id AS id, content.user_id AS user_id, content.created_at AS created_at FROM content \
                     WHERE content.delete_requested_at IS NULL AND {}",
                    Self::WITHIN_RETENTION
                ),
                params![oldest, oldest],
            )
            .await?;
        self.mark_content(&Self::marked(&rows)?, true).await?;
        // Not the accounts that were deleted, whose credits are gone for good.
        let users = db.fetch("SELECT id, username FROM users WHERE deleted_at IS NULL", &[]).await?;
        self.put_credits(&users).await?;
        self.sync_following(&strings(&users, "id")?).await
    }

    /// (tag, day) of content liked in [since, the run's start), and of content that lost a
    /// like then (DELETE /like): the days are written again with the counts as they now are.
    /// The liked content is re-admitted if it was trimmed. Content that lost a like isn't: a
    /// day holds it or not as before, with fewer likes.
    async fn mark_new_likes(&self, since: i64) -> Result<()> {
        let db = &self.deps.db;
        let (until, oldest) = (self.run_start, self.oldest());
        let liked = db
            .fetch(
                &format!(
                    "SELECT DISTINCT content.id AS id, content.user_id AS user_id, content.created_at AS created_at FROM likes \
                     INNER JOIN content ON content.id = likes.content_id \
                     WHERE likes.created_at >= ? AND likes.created_at < ? AND {}",
                    Self::WITHIN_RETENTION
                ),
                params![since, until, oldest, oldest],
            )
            .await?;
        self.mark_content(&Self::marked(&liked)?, true).await?;
        // The row of a like that was taken back is gone: the content says when it last lost one.
        let unliked = db
            .fetch(
                &format!(
                    "SELECT content.id AS id, content.user_id AS user_id, content.created_at AS created_at FROM content \
                     WHERE content.unliked_at >= ? AND content.unliked_at < ? AND content.delete_requested_at IS NULL AND {}",
                    Self::WITHIN_RETENTION
                ),
                params![since, until, oldest, oldest],
            )
            .await?;
        self.mark_content(&Self::marked(&unliked)?, false).await?;
        Ok(())
    }

    /// Rewrites the Redis credit of users who registered or changed their username in [since,
    /// the run's start). The request already wrote it; this repairs a write that failed.
    async fn sync_changed_publishers(&self, since: i64) -> Result<()> {
        let users = self
            .deps
            .db
            .fetch(
                "SELECT id, username FROM users WHERE updated_at >= ? AND updated_at < ? AND deleted_at IS NULL",
                params![since, self.run_start],
            )
            .await?;
        if users.is_empty() {
            return Ok(());
        }
        self.put_credits(&users).await
    }

    /// Writes the credits of users, from rows of `id` and `username`.
    async fn put_credits(&self, users: &[evieverse_core::db::Row]) -> Result<()> {
        self.lease.check().await?;
        map_limit(users, SMALL_WRITES, |user| async move {
            self.deps.publishers.put(user.str("id")?, user.str("username")?).await
        })
        .await
    }

    /// Rewrites the follows in Redis of users who followed someone in [since, the run's
    /// start). The request already wrote them; this repairs a write that failed, or two that
    /// raced. An unfollow leaves no row to find its user by, so its request fails if its write
    /// does.
    async fn sync_changed_following(&self, since: i64) -> Result<()> {
        let followers = self
            .deps
            .db
            .fetch(
                "SELECT DISTINCT follower_id FROM follows WHERE created_at >= ? AND created_at < ?",
                params![since, self.run_start],
            )
            .await?;
        self.sync_following(&strings(&followers, "follower_id")?).await
    }

    /// Writes to Redis whom each of these users follows, as the database has it.
    async fn sync_following(&self, user_ids: &[String]) -> Result<()> {
        let Deps { db, follows, .. } = self.deps;
        for batch in user_ids.chunks(BATCH) {
            self.lease.check().await?;
            let mut following: IndexMap<&str, Vec<String>> = batch.iter().map(|id| (id.as_str(), Vec::new())).collect();
            let rows = db
                .fetch(
                    &format!("SELECT follower_id, followee_id FROM follows WHERE follower_id IN ({})", places(batch.len())),
                    &values(batch),
                )
                .await?;
            for row in &rows {
                if let Some(followees) = following.get_mut(row.str("follower_id")?) {
                    followees.push(row.string("followee_id")?);
                }
            }
            map_limit(&following, SMALL_WRITES, |(user_id, followees)| follows.put(user_id, followees)).await?;
        }
        Ok(())
    }

    /// Works out again, and writes to Redis, the related hashtags of every hashtag with a
    /// count in `tag_pairs` made in [since, the run's start less the grace period), or of
    /// every hashtag there: with `everything`, and when no run has applied any yet. Returns
    /// the instant the counts are now applied through: `since` if it failed, which is logged,
    /// and leaves them for the next run, as nothing else a run does depends on it.
    ///
    /// A count is stamped when its statement runs, by the node that runs it, so one stamped
    /// before the grace period may only be readable, or only seem that old, once it has
    /// passed: counts younger than that wait for a later run.
    async fn sync_related_tags(&self, since: i64, everything: bool) -> Result<i64> {
        let Deps {
            db, related_tags, log, config, ..
        } = self.deps;
        let until = since.max(self.run_start - config.compact.grace_seconds * 1000);
        // No run has applied any yet (or Redis lost which had): every hashtag's are due.
        let all = everything || since == 0;
        if until == since && !all {
            return Ok(since);
        }
        let syncing = async {
            // Every hashtag counted has the row of its own posts.
            let rows = if all {
                db.fetch("SELECT tag_a, tag_b FROM tag_pairs WHERE tag_a = tag_b", &[]).await?
            } else {
                db.fetch(
                    "SELECT tag_a, tag_b FROM tag_pairs WHERE updated_at >= ? AND updated_at < ?",
                    params![since, until],
                )
                .await?
            };
            let mut tags: IndexSet<String> = IndexSet::new();
            for row in &rows {
                tags.insert(row.string("tag_a")?);
                tags.insert(row.string("tag_b")?);
            }
            let tags: Vec<String> = tags.into_iter().collect();
            for batch in tags.chunks(BATCH) {
                self.lease.check().await?;
                map_limit(batch, self.deps.concurrency(), |tag| async move {
                    related_tags.put(tag, &self.related_to(tag).await?).await
                })
                .await?;
            }
            Ok(())
        }
        .await;
        match syncing {
            Ok(()) => Ok(until),
            Err(err) if is_lease_lost(&err) => Err(err),
            Err(err) => {
                log.error(
                    json!({ "err": log::err(&err) }),
                    "could not work out related hashtags; the next run tries again",
                );
                Ok(since)
            }
        }
    }

    /// The hashtags related to `tag`, most related first: those on the most posts that carry
    /// `tag` too, of the ones on at least `relatedMinPosts` such posts which are at least
    /// `relatedMinPercent` of all the posts that carry `tag`. At most `relatedTags` of them.
    ///
    /// It is one-sided: #pets is related to #dogs when a good share of the posts under #dogs
    /// are under #pets too, whatever share of #pets' posts they are.
    async fn related_to(&self, tag: &str) -> Result<Vec<String>> {
        let db = &self.deps.db;
        let feed = &self.deps.config.feed;
        let most = feed.related_tags;
        let own = db
            .fetch_optional("SELECT posts FROM tag_pairs WHERE tag_a = ? AND tag_b = ?", params![tag, tag])
            .await?;
        let Some(own) = own.filter(|_| most > 0) else { return Ok(Vec::new()) };
        // The share of its posts, rounded up to a whole post.
        let share = (own.i64("posts")? * feed.related_min_percent + 99).div_euclid(100);
        let least = feed.related_min_posts.max(share);
        // A pair's row names its hashtags in order, so `tag` is the first of some of its pairs and the second of the others.
        let mut related: Vec<(i64, String)> = Vec::new();
        for (own, other) in [("tag_a", "tag_b"), ("tag_b", "tag_a")] {
            let rows = db
                .fetch(
                    &format!(
                        "SELECT {other} AS tag, posts FROM tag_pairs WHERE {own} = ? AND {other} <> ? AND posts >= ? \
                         ORDER BY posts DESC, {other} LIMIT ?"
                    ),
                    params![tag, tag, least, most],
                )
                .await?;
            for row in &rows {
                related.push((row.i64("posts")?, row.string("tag")?));
            }
        }
        related.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        Ok(related.into_iter().take(usize::try_from(most).unwrap_or(0)).map(|(_, tag)| tag).collect())
    }

    /// Publishes the server's ads (src/monetization.ts) to Redis, where feeds and posts read
    /// them: every ad of the `monetization` table that hasn't ended at the run's start, those
    /// yet to start among them, each with its schedule, which whoever shows it holds it to.
    /// So an ad that an admin created, changed or deleted shows as it now is after the next
    /// run, and one that only starts or ends does so on time, with no run between.
    ///
    /// All of them, every run, as there are few; Redis is written only if what it holds isn't
    /// what the table says. A server that shows no ads has none published, and nothing is read
    /// for it. A failure is logged and left for the next run, as nothing else a run does
    /// depends on it.
    async fn sync_ads(&self) -> Result<()> {
        let Deps { db, ads, log, config, .. } = self.deps;
        if !config.monetization.feed_ads && !config.monetization.post_ads {
            return Ok(());
        }
        let syncing = async {
            // In an order of its own, so the same ads are published as the same bytes.
            let rows = db
                .fetch(
                    "SELECT id, kind, text, image_alt, url, tags, starts_at, ends_at FROM monetization \
                     WHERE (ends_at IS NULL OR ends_at > ?) ORDER BY created_at, id",
                    params![self.run_start],
                )
                .await?;
            let published = rows.iter().map(PublishedAd::of).collect::<Result<Vec<PublishedAd>>>()?;
            self.lease.check().await?;
            if ads.sync(&published).await? {
                log.info(json!({ "ads": published.len() }), "published the ads");
            }
            Ok(())
        }
        .await;
        match syncing {
            Err(err) if !is_lease_lost(&err) => {
                log.error(json!({ "err": log::err(&err) }), "could not publish the ads; the next run tries again");
                Ok(())
            }
            outcome => outcome,
        }
    }

    /// The feed queue's rows this run takes: all of them, as every one is a write's that
    /// committed. In one statement, so the rows of a write are taken together or not at all.
    async fn read_queue(&self) -> Result<Vec<QueueRow>> {
        self.deps
            .db
            .fetch(
                "SELECT content.id AS id, feed_queue.tag AS tag, feed_queue.token AS token, feed_queue.created_at AS queued_at, \
                 content.created_at AS created_at FROM feed_queue INNER JOIN content ON content.id = feed_queue.content_id",
                &[],
            )
            .await?
            .iter()
            .map(|row| {
                Ok(QueueRow {
                    id: row.string("id")?,
                    tag: row.string("tag")?,
                    token: row.string("token")?,
                    queued_at: row.i64("queued_at")?,
                    created_at: row.i64("created_at")?,
                })
            })
            .collect()
    }

    /// Marks the content of each row to be rechecked in its tag: its entry is rebuilt from the
    /// database and its meta file, so it is added where a write gave it the tag, replaced
    /// where it kept it, and dropped where it no longer carries it. Several writes of the same
    /// content since the last run left one row per tag, and are one entry rebuilt.
    ///
    /// Its entry in the tag is in the day it was created, or, where a repost placed it in the
    /// tag, in the day of the repost. It is rechecked in both: it has an entry in at most one
    /// (see `rebuilt`), and the other is where it may have had one before.
    fn mark_queue(&self, rows: &[QueueRow]) {
        let oldest = self.oldest();
        for row in rows {
            let placed = self.places.of(&row.id);
            let place = placed.iter().find(|place| place.tag == row.tag).map(|place| place.created_at);
            for at in [Some(row.created_at), place].into_iter().flatten() {
                // Past retention there is no day to rebuild; the row just goes.
                if at > oldest {
                    self.work.recheck(&row.tag, utc_day(at), &row.id);
                }
            }
        }
    }

    /// Has the indexes planned that queued content past retention was in from its creation:
    /// its hashtags' and its publisher's own. Such content is queued when it is reposted, or
    /// updated, and its summary is then written again. An index nothing was written under
    /// since the content's day passed retention still names that day, which no feed showed for
    /// want of the summary: planned, it drops the day (see `plan`), so the content is only
    /// where a repost placed it.
    async fn mark_outlived(&self, rows: &[QueueRow]) -> Result<()> {
        let oldest = self.oldest();
        let old: Vec<String> = rows
            .iter()
            .filter(|row| row.created_at <= oldest)
            .map(|row| &row.id)
            .collect::<IndexSet<_>>()
            .into_iter()
            .cloned()
            .collect();
        if old.is_empty() {
            return Ok(());
        }
        let found = content_rows(&self.deps.db, &old).await?;
        map_limit(&old, META_READS, |id| {
            let found = &found;
            async move {
                if let Some(row) = found.get(id) {
                    self.work.touch(&author_index(&row.user_id));
                }
                if let Ok(Some(meta)) = self.meta(id).await {
                    for tag in &meta.tags {
                        self.work.touch(tag);
                    }
                }
                Ok(())
            }
        })
        .await
    }

    /// Finds the places in a user's own index whose reposter's account was deleted: what they
    /// reposted is theirs to show no more. The days they are in are marked, and for the rest
    /// of the run the places count as not there, so the entries are dropped. Returns them, to
    /// be deleted once their indexes are compacted (see `settle_gone_reposters`), which is
    /// what lets the account's row go (see `purge_accounts`). The hashtags the user gave
    /// content stay.
    async fn mark_gone_reposters(&self) -> Result<Vec<GonePlace>> {
        let db = &self.deps.db;
        let closed = strings(&db.fetch("SELECT id FROM users WHERE deleted_at IS NOT NULL", &[]).await?, "id")?;
        let mut gone = Vec::new();
        for batch in closed.chunks(BATCH) {
            let rows = db
                .fetch(
                    &format!("SELECT content_id, tag, created_at FROM reposts WHERE user_id IN ({})", places(batch.len())),
                    &values(batch),
                )
                .await?;
            for row in &rows {
                let (id, tag) = (row.string("content_id")?, row.string("tag")?);
                // Not the hashtags they gave the content: those are the content's now.
                if index_author(&tag).is_none() {
                    continue;
                }
                self.work.day(&tag, utc_day(row.i64("created_at")?));
                self.places.take_away(&tag, &id);
                gone.push(GonePlace { id, tag });
            }
        }
        Ok(gone)
    }

    /// Deletes the places `mark_gone_reposters` found, of the indexes this run compacted:
    /// their entries are gone.
    async fn settle_gone_reposters(&self, gone: &[GonePlace], failed: &HashSet<String>) -> Result<()> {
        for place in gone {
            if failed.contains(&place.tag) {
                continue;
            }
            self.lease.check().await?;
            self.deps
                .db
                .execute("DELETE FROM reposts WHERE content_id = ? AND tag = ?", params![&place.id, &place.tag])
                .await?;
        }
        Ok(())
    }

    /// Reads the places of the reposts that were removed and that no run has taken away yet
    /// (`repost_removals`): all of them. The removal deleted the repost's rows of `reposts`
    /// in the commit that left these, so the places of their content are read again here, for
    /// the rest of the run: applying a write may have read them before the removal committed.
    async fn read_removals(&self) -> Result<Vec<RemovedPlace>> {
        let removals = self
            .deps
            .db
            .fetch("SELECT id, content_id, tag, reposted_at FROM repost_removals", &[])
            .await?
            .iter()
            .map(|row| {
                Ok(RemovedPlace {
                    key: row.string("id")?,
                    id: row.string("content_id")?,
                    tag: row.string("tag")?,
                    reposted_at: row.i64("reposted_at")?,
                })
            })
            .collect::<Result<Vec<RemovedPlace>>>()?;
        let ids: IndexSet<&String> = removals.iter().map(|removal| &removal.id).collect();
        for id in &ids {
            self.places.forget(id);
        }
        self.places.load(ids).await?;
        Ok(removals)
    }

    /// Takes away what the reposts that were removed had added: an admin or a server
    /// moderator removed them, and the content stays, as its publisher and its other reposts
    /// made it. For each place of such a repost:
    ///
    /// - The hashtag it gave is taken off the content, and the copy of its summary under the
    ///   day of the repost is erased (see `unplace`).
    /// - The day of the repost is marked under the index, with the content to be rechecked
    ///   there: its entry is rebuilt from the database, which has no such place any more, and
    ///   so dropped (see `rebuilt`). Under a hashtag the content's own day is too: a run that
    ///   read the places after the removal committed, and these rows before, took the hashtag
    ///   for the content's own, and may have given it an entry there.
    ///
    /// Content set for deletion keeps what it has until it goes: its days are marked, and its
    /// deletion takes the copies of its summary with it (see `mark_deletions`).
    ///
    /// Returns the places it took away, each deleted once its index is compacted (see
    /// `settle_removals`). Those of content it couldn't write aren't among them, so the next
    /// run tries again.
    async fn apply_removals(&self, removals: &[RemovedPlace]) -> Result<Vec<RemovedPlace>> {
        if removals.is_empty() {
            return Ok(Vec::new());
        }
        let mut by_content: IndexMap<&String, Vec<&RemovedPlace>> = IndexMap::new();
        for removal in removals {
            by_content.entry(&removal.id).or_default().push(removal);
        }
        let ids: Vec<String> = by_content.keys().map(|id| (*id).clone()).collect();
        let rows = content_rows(&self.deps.db, &ids).await?;
        self.lease.check().await?;
        let unapplied: RefCell<HashSet<&String>> = RefCell::new(HashSet::new());
        map_limit(&by_content, SMALL_WRITES, |(id, places)| {
            let (rows, unapplied) = (&rows, &unapplied);
            async move {
                let Some(row) = rows.get(*id).filter(|row| !row.deleting()) else {
                    return Ok(());
                };
                match self.unplace(row, places).await {
                    Err(err) if is_lease_lost(&err) => return Err(err),
                    Err(err) => {
                        unapplied.borrow_mut().insert(*id);
                        self.deps.log.error(
                            json!({ "err": log::err(&err), "contentId": id }),
                            "could not take what a removed repost gave the content off it",
                        );
                    }
                    Ok(()) => {}
                }
                Ok(())
            }
        })
        .await?;

        let (oldest, unapplied) = (self.oldest(), unapplied.into_inner());
        let mut applied = Vec::new();
        for removal in removals {
            // The content is gone, and these rows with it.
            let Some(row) = rows.get(&removal.id) else { continue };
            let own = index_author(&removal.tag).is_none().then_some(row.created_at);
            for at in [Some(removal.reposted_at), own].into_iter().flatten() {
                // Past retention no index holds the content.
                if at > oldest {
                    self.work.recheck(&removal.tag, utc_day(at), &removal.id);
                }
            }
            if !unapplied.contains(&removal.id) {
                applied.push(removal.clone());
            }
        }
        Ok(applied)
    }

    /// Writes a piece of content again as `next` has it: its summary, unless it is withheld,
    /// when it has none and gets none here; the terms a search finds it by; and its meta file,
    /// last, as for any write: what it says is there. The terms before the meta file, so a run
    /// that stops between the two writes both again.
    async fn rewrite(&self, row: &ContentRow, next: ContentMeta, reposted_at: &[i64]) -> Result<()> {
        let Deps {
            db,
            content,
            summaries,
            config,
            ..
        } = self.deps;
        if !row.withheld() {
            summaries.put(&summary_of(row.posted(), &next, &config.public_base_url, reposted_at)).await?;
        }
        index_content(db, &row.id, row.created_at, &next, max_keywords(self.deps)).await?;
        content.put_meta(&next).await?;
        self.set_meta(&row.id, next);
        Ok(())
    }

    /// Takes off a piece of content the hashtags that removed reposts gave it (`places`, see
    /// `apply_removals`): writes its summary and meta file again without them, as a
    /// moderator's removal of a hashtag is written (see `untag`). Not a hashtag that a repost
    /// gives it now: the place was given again since the removal, and the hashtag is that
    /// repost's.
    ///
    /// A hashtag comes off whatever the content's meta file says of it by now. Its publisher
    /// may have sent an update that names it since the removal, and nothing tells that from
    /// the hashtag the repost gave: it goes, and is theirs to send again once the removal is
    /// settled.
    ///
    /// Then the copies of the summary under the days of those reposts are erased, where no
    /// place the content still has keeps one: nothing writes them from now on, so one left
    /// behind would say what the content was when the repost was removed, for as long as its
    /// day is kept.
    async fn unplace(&self, row: &ContentRow, places: &[&RemovedPlace]) -> Result<()> {
        let Deps { content, summaries, .. } = self.deps;
        let placed = self.places.of(&row.id);
        let given: HashSet<&str> = placed.iter().map(|place| place.tag.as_str()).collect();
        let taken: HashSet<&str> = places
            .iter()
            .map(|place| place.tag.as_str())
            .filter(|tag| index_author(tag).is_none() && !given.contains(tag))
            .collect();
        let reposted_at = repost_times(&placed);
        if let Some(meta) = content.get_meta(&row.id).await?
            && meta.tags.iter().any(|tag| taken.contains(tag.as_str()))
        {
            let next = ContentMeta {
                tags: meta.tags.iter().filter(|tag| !taken.contains(tag.as_str())).cloned().collect(),
                updated_at: meta.updated_at.max(self.run_start),
                ..meta
            };
            self.rewrite(row, next, &reposted_at).await?;
        }
        let gone: Vec<i64> = places.iter().map(|place| place.reposted_at).collect();
        let summary = SummaryRef {
            content_id: row.id.clone(),
            created_at: row.created_at,
            reposted_at,
        };
        summaries.erase_copies(&summary, &gone).await
    }

    /// Deletes the rows of the places `apply_removals` took away, of the indexes this run
    /// compacted: their entries are gone. A row of an index that failed stays, and has its day
    /// marked again by the next run.
    ///
    /// Not while a write of the content is still to be applied: one that failed in this run,
    /// or waits for its video, or committed since this run applied the others. Such a write
    /// may hold the hashtag, as the content had it when the write was made, and the row is
    /// what takes it off that when it is applied (see `apply_pending`). The content's row is
    /// locked for the look, as a write of the content locks it: a write that is committing is
    /// waited for, and one that begins after reads the meta file as this run left it.
    async fn settle_removals(&self, removals: &[RemovedPlace], failed: &HashSet<String>) -> Result<()> {
        let db = &self.deps.db;
        let mut done: IndexMap<&String, Vec<&String>> = IndexMap::new();
        for removal in removals {
            if !failed.contains(&removal.tag) {
                done.entry(&removal.id).or_default().push(&removal.key);
            }
        }
        for (id, keys) in done {
            self.lease.check().await?;
            let mut tx = db.begin().await?;
            // SQLite runs one transaction at a time, and has no rows to lock.
            if db.dialect() != Dialect::Sqlite {
                tx.fetch("SELECT id FROM content WHERE id = ? FOR UPDATE", params![id]).await?;
            }
            let waiting = tx
                .fetch_optional(
                    "SELECT seq FROM pending_writes WHERE content_id = ? AND kind = ? LIMIT 1",
                    params![id, evieverse_core::pending::kind::POST],
                )
                .await?;
            if waiting.is_none() {
                for batch in keys.chunks(BATCH) {
                    tx.execute(
                        &format!("DELETE FROM repost_removals WHERE id IN ({})", places(batch.len())),
                        &values(batch.iter().copied()),
                    )
                    .await?;
                }
            }
            tx.commit().await?;
        }
        Ok(())
    }

    /// Writes the hashtags reposts gave content into its meta file and summary, for the
    /// content of the queue's rows: a repost commits its places and queues the content, and
    /// this is what makes the content carry the hashtags, which is when it has an entry under
    /// them (see `placement`) and feeds show it there. Not a hashtag a moderator removed from
    /// the content, which stays off it.
    ///
    /// An update of the content that this run applied has them already: applying a post's
    /// write settles its hashtags by the places reposts gave it (see `apply_pending`),
    /// whatever the update knew of them.
    ///
    /// Content that is withheld (it waits in the moderation queue, or its original is gone
    /// from another server) has no summary, and gets none here. Returns the content it
    /// couldn't write: its rows stay in the queue, so the next run tries again.
    async fn apply_reposts(&self, queue: &[QueueRow]) -> Result<HashSet<String>> {
        let Deps { db, log, .. } = self.deps;
        let given = |id: &str| reposted_tags(self.places.of(id).iter().map(|place| place.tag.as_str()));
        let ids: Vec<String> = queue
            .iter()
            .map(|row| &row.id)
            .collect::<IndexSet<_>>()
            .into_iter()
            .filter(|id| !given(id).is_empty())
            .cloned()
            .collect();
        if ids.is_empty() {
            return Ok(HashSet::new());
        }

        let rows = content_rows(db, &ids).await?;
        let mut removed: HashMap<String, HashSet<String>> = HashMap::new();
        for batch in ids.chunks(BATCH) {
            let mut params = values(batch);
            params.push(Value::from("removed"));
            let decided = db
                .fetch(
                    &format!(
                        "SELECT content_id, tag FROM tag_moderation WHERE content_id IN ({}) AND decision = ?",
                        places(batch.len())
                    ),
                    &params,
                )
                .await?;
            for row in &decided {
                removed.entry(row.string("content_id")?).or_default().insert(row.string("tag")?);
            }
        }
        self.lease.check().await?;
        let unapplied: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
        map_limit(&ids, SMALL_WRITES, |id| {
            let (rows, removed, unapplied, given) = (&rows, &removed, &unapplied, &given);
            async move {
                // Content set for deletion keeps what it has until it goes.
                let Some(row) = rows.get(id).filter(|row| !row.deleting()) else {
                    return Ok(());
                };
                let writing = async {
                    let Some(meta) = self.meta(id).await? else { return Ok(()) };
                    let missing: Vec<String> = given(id)
                        .into_iter()
                        .filter(|tag| !meta.tags.contains(tag) && !removed.get(id).is_some_and(|removed| removed.contains(tag)))
                        .collect();
                    if missing.is_empty() {
                        return Ok(());
                    }
                    let next = ContentMeta {
                        tags: meta.tags.iter().cloned().chain(missing).collect(),
                        updated_at: meta.updated_at.max(self.run_start),
                        ..(*meta).clone()
                    };
                    self.rewrite(row, next, &repost_times(&self.places.of(id))).await
                }
                .await;
                match writing {
                    Err(err) if is_lease_lost(&err) => return Err(err),
                    Err(err) => {
                        unapplied.borrow_mut().insert(id.clone());
                        log.error(
                            json!({ "err": log::err(&err), "contentId": id }),
                            "could not write the hashtags a repost gave the content to it",
                        );
                    }
                    Ok(()) => {}
                }
                Ok(())
            }
        })
        .await?;
        Ok(unapplied.into_inner())
    }

    /// Reads the meta files of queued content, each once however many tags it is queued
    /// under, and several at once. One that can't be read fails the tags that need it, when
    /// they ask for it.
    async fn prefetch(&self, rows: &[QueueRow]) -> Result<()> {
        let ids: IndexSet<&String> = rows.iter().map(|row| &row.id).collect();
        map_limit(ids, META_READS, |id| async move {
            let _ = self.meta(id).await;
            Ok(())
        })
        .await
    }

    /// Deletes the rows this run took whose tag it compacted. By the token it read: a row a
    /// write has stamped again since holds another, and is the next run's, which applies that
    /// write.
    async fn settle_queue(&self, rows: &[&QueueRow], failed: &HashSet<String>) -> Result<()> {
        let db = &self.deps.db;
        // A write with a row under a tag that failed keeps that row, so its others are deleted one by one.
        let partial: HashSet<&String> = rows.iter().filter(|row| failed.contains(&row.tag)).map(|row| &row.token).collect();
        let whole: Vec<&String> = rows
            .iter()
            .map(|row| &row.token)
            .filter(|token| !partial.contains(token))
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect();
        for batch in whole.chunks(BATCH) {
            self.lease.check().await?;
            db.execute(
                &format!("DELETE FROM feed_queue WHERE token IN ({})", places(batch.len())),
                &values(batch.iter().copied()),
            )
            .await?;
        }
        for row in rows {
            if !partial.contains(&row.token) || failed.contains(&row.tag) {
                continue;
            }
            self.lease.check().await?;
            db.execute(
                "DELETE FROM feed_queue WHERE content_id = ? AND tag = ? AND token = ?",
                params![&row.id, &row.tag, &row.token],
            )
            .await?;
        }
        Ok(())
    }

    /// Applies what tag moderators decided before the run's start that no run has applied
    /// yet. A hashtag they removed is taken off the content (see `untag`). For either
    /// decision the content's UTC day is marked under the hashtag, and its index is built to
    /// the decisions (see `refreshed` and `rebuilt`): it flags what is approved and leaves out
    /// what is removed. Returns the decisions, each recorded as applied once its hashtag is
    /// compacted (see `settle_decisions`); a removal that couldn't be taken off the content
    /// isn't among them, so the next run tries again.
    ///
    /// A removal with no moderator is one of these too: a hashtag a repost gave the content,
    /// which an update of the content was then refused by the hashtag's own rules.
    async fn apply_decisions(&self) -> Result<Vec<Decision>> {
        // Content set for deletion keeps its hashtags until it goes, and its decisions go with it.
        let rows = self
            .deps
            .db
            .fetch(
                &format!(
                    "SELECT {CONTENT_COLUMNS}, tag_moderation.tag AS tag, tag_moderation.decision AS decision, \
                     tag_moderation.decided_at AS decided_at \
                     FROM tag_moderation INNER JOIN content ON content.id = tag_moderation.content_id \
                     LEFT JOIN moderation_queue ON moderation_queue.content_id = content.id \
                     WHERE tag_moderation.applied_at IS NULL AND tag_moderation.decided_at < ? AND content.delete_requested_at IS NULL"
                ),
                params![self.run_start],
            )
            .await?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let mut decided = Vec::with_capacity(rows.len());
        for row in &rows {
            let decision = Decision {
                id: row.string("id")?,
                tag: row.string("tag")?,
                removed: row.str("decision")? == "removed",
                decided_at: row.i64("decided_at")?,
            };
            decided.push((ContentRow::of(row)?, decision));
        }

        self.places.load(decided.iter().map(|(row, _)| &row.id)).await?;
        self.lease.check().await?;
        let removed: IndexMap<&String, &ContentRow> = decided.iter().filter(|(_, decision)| decision.removed).map(|(row, _)| (&row.id, row)).collect();
        let unapplied: RefCell<HashSet<&String>> = RefCell::new(HashSet::new());
        map_limit(removed.values(), SMALL_WRITES, |row| {
            let unapplied = &unapplied;
            async move {
                match self.untag(row).await {
                    Err(err) if is_lease_lost(&err) => return Err(err),
                    Err(err) => {
                        unapplied.borrow_mut().insert(&row.id);
                        self.deps.log.error(
                            json!({ "err": log::err(&err), "contentId": row.id }),
                            "could not take the hashtags a moderator removed off the content",
                        );
                    }
                    Ok(()) => {}
                }
                Ok(())
            }
        })
        .await?;

        let (oldest, unapplied) = (self.oldest(), unapplied.into_inner());
        let unapplied: HashSet<String> = unapplied.into_iter().cloned().collect();
        let mut applied = Vec::new();
        for (row, decision) in decided {
            // Where its entry under the hashtag is: at its creation, or at the repost that gave it the hashtag.
            let placed = self.places.of(&row.id);
            let at = placed
                .iter()
                .find(|place| place.tag == decision.tag)
                .map_or(row.created_at, |place| place.created_at);
            // Past retention no index holds the content.
            if at > oldest {
                self.work.day(&decision.tag, utc_day(at));
            }
            if decision.removed && unapplied.contains(&row.id) {
                continue;
            }
            applied.push(decision);
        }
        Ok(applied)
    }

    /// Takes off a piece of content the hashtags moderators removed from it: writes its
    /// summary and meta file again without them, which is what the content carries from then
    /// on. Its bytes stay as they are, and its other hashtags' indexes aren't touched: they
    /// show the summary as it now is. Content left with no hashtag stays, in no hashtag's
    /// index: it is still its publisher's, and in their own. Content that doesn't carry them
    /// (any more) is left as it is.
    ///
    /// The summary is also what takes the content out of the hashtag's feeds in the indexes
    /// this run doesn't rebuild, which feed sessions under way still read: a feed leaves out a
    /// record whose summary doesn't carry the hashtag it is listed under. Content that is
    /// withheld has no summary, and gets none here, which would put it back in those feeds.
    async fn untag(&self, row: &ContentRow) -> Result<()> {
        let Deps { db, content, .. } = self.deps;
        // All of them, not only this run's: the meta file carries none that was removed.
        let removed: HashSet<String> = strings(
            &db.fetch(
                "SELECT tag FROM tag_moderation WHERE content_id = ? AND decision = ?",
                params![&row.id, "removed"],
            )
            .await?,
            "tag",
        )?
        .into_iter()
        .collect();
        let Some(meta) = content.get_meta(&row.id).await? else { return Ok(()) };
        let tags: Vec<String> = meta.tags.iter().filter(|tag| !removed.contains(*tag)).cloned().collect();
        if tags.len() == meta.tags.len() {
            return Ok(());
        }
        let next = ContentMeta {
            tags,
            updated_at: meta.updated_at.max(self.run_start),
            ..meta
        };
        self.rewrite(row, next, &repost_times(&self.places.of(&row.id))).await
    }

    /// Records as applied the decisions whose hashtag this run compacted, so the next run
    /// doesn't apply them again.
    ///
    /// A removed hashtag that a repost had given the content loses its place with it
    /// (`reposts`): the entry is gone from the hashtag's index, and the removal keeps the
    /// hashtag off the content.
    async fn settle_decisions(&self, decisions: &[Decision], failed: &HashSet<String>) -> Result<()> {
        let db = &self.deps.db;
        for decision in decisions {
            if failed.contains(&decision.tag) {
                continue;
            }
            self.lease.check().await?;
            // Not a decision made since: this run applied the one before it.
            db.execute(
                "UPDATE tag_moderation SET applied_at = ? WHERE content_id = ? AND tag = ? AND decided_at = ? AND applied_at IS NULL",
                params![self.run_start, &decision.id, &decision.tag, decision.decided_at],
            )
            .await?;
            if decision.removed {
                db.execute("DELETE FROM reposts WHERE content_id = ? AND tag = ?", params![&decision.id, &decision.tag])
                    .await?;
            }
        }
        Ok(())
    }

    /// Sets for deletion the entries for posts on other servers that have been hidden for
    /// REPOSTS_GONE_DAYS: the original's server said it published no post there, and has
    /// attested none since, so the post is taken for deleted. Until then the entry could come
    /// back, which is why it was hidden and not deleted: the same word is signed for a post
    /// that only waits in a moderation queue. The run then deletes them like any content set
    /// for deletion (see `mark_deletions`), with the places reposts gave them.
    ///
    /// One statement, which sets only an entry that is still hidden as it runs: an
    /// attestation that brings the entry back commits before it, and keeps the entry, or
    /// after it, and is refused as any write of content set for deletion is.
    async fn expire_gone(&self) -> Result<()> {
        self.lease.check().await?;
        let entries = self
            .deps
            .db
            .execute(
                "UPDATE content SET delete_requested_at = ? WHERE origin_gone_at IS NOT NULL AND origin_gone_at <= ? AND delete_requested_at IS NULL",
                params![self.run_start, self.run_start - self.deps.config.reposts.gone_days * DAY],
            )
            .await?;
        if entries > 0 {
            self.deps.log.info(
                json!({ "entries": entries }),
                "set for deletion the reposts of posts that have been gone from their own servers for REPOSTS_GONE_DAYS",
            );
        }
        Ok(())
    }

    /// Content set for deletion, all of it: no write of it commits once the deletion is set,
    /// none that committed before is applied any more (see `apply_pending`), and the index
    /// holds no entry this run can't rebuild, so nothing has to be waited for. Marked under
    /// its hashtags and under those a write of it left a row in the feed queue for (whether
    /// this run took the row or not: a hashtag an update dropped), so each of its entries is
    /// dropped. Returns the rows with the tags whose compaction must succeed before the
    /// content is deleted.
    ///
    /// `removals` are the places of reposts that were removed and not taken away yet (see
    /// `apply_removals`), which marked their days: for content among these, their indexes are
    /// waited for too, and the summary's copy under the day of each such repost goes with the
    /// others.
    async fn mark_deletions(&self, removals: &[RemovedPlace]) -> Result<Vec<Deletion>> {
        let db = &self.deps.db;
        let rows = Self::marked(
            &db.fetch("SELECT id, user_id, created_at FROM content WHERE delete_requested_at IS NOT NULL", &[])
                .await?,
        )?;
        let tags_of = self.mark_content(&rows, false).await?;
        let mut queued: HashMap<String, Vec<String>> = HashMap::new();
        for batch in rows.chunks(BATCH) {
            let found = db
                .fetch(
                    &format!("SELECT content_id, tag FROM feed_queue WHERE content_id IN ({})", places(batch.len())),
                    &values(batch.iter().map(|row| &row.id)),
                )
                .await?;
            for row in &found {
                queued.entry(row.string("content_id")?).or_default().push(row.string("tag")?);
            }
        }
        let mut deletions = Vec::with_capacity(rows.len());
        for (row, tags) in rows.into_iter().zip(tags_of) {
            let mut tags: IndexSet<String> = tags.into_iter().collect();
            // Under a tag a repost placed it in, its day is the repost's, which `mark_content` marked.
            for tag in queued.remove(&row.id).unwrap_or_default() {
                self.work.day(&tag, utc_day(row.created_at));
                tags.insert(tag);
            }
            // When it was reposted: its summary is under those days too, and goes from them with it.
            let mut reposted_at: Vec<i64> = self.places.of(&row.id).iter().map(|place| place.created_at).collect();
            for removal in removals.iter().filter(|removal| removal.id == row.id) {
                tags.insert(removal.tag.clone());
                reposted_at.push(removal.reposted_at);
            }
            reposted_at.sort_unstable();
            reposted_at.dedup();
            deletions.push(Deletion {
                id: row.id,
                created_at: row.created_at,
                reposted_at,
                tags: tags.into_iter().collect(),
            });
        }
        Ok(deletions)
    }

    /// Marks the content's UTC day under each of its hashtags, read from its meta file, and
    /// under its publisher's own index; returns every index marked for each row, in the rows'
    /// order. Where a repost placed the content in an index (a hashtag it gave it, the
    /// reposter's own), the day is the repost's. With `readmit`, the content is reconsidered
    /// in each of those days if the day doesn't hold it.
    async fn mark_content(&self, rows: &[Marked], readmit: bool) -> Result<Vec<Vec<String>>> {
        self.places.load(rows.iter().map(|row| &row.id)).await?;
        let tags_of: RefCell<Vec<Vec<String>>> = RefCell::new(vec![Vec::new(); rows.len()]);
        map_limit(rows.iter().enumerate(), SMALL_WRITES, |(i, row)| {
            let tags_of = &tags_of;
            async move {
                let placed = self.places.of(&row.id);
                let placed_at: IndexMap<&str, i64> = placed.iter().map(|place| (place.tag.as_str(), place.created_at)).collect();
                // The content is its publisher's, whatever its meta file holds.
                let mut tags: IndexSet<String> = match self.meta(&row.id).await? {
                    Some(meta) => meta.tags.iter().cloned().collect(),
                    None => IndexSet::new(),
                };
                tags.insert(author_index(&row.user_id));
                tags.extend(placed_at.keys().map(|tag| (*tag).to_owned()));
                for tag in &tags {
                    let day = utc_day(placed_at.get(tag.as_str()).copied().unwrap_or(row.created_at));
                    if readmit {
                        self.work.readmit(tag, day, &row.id);
                    } else {
                        self.work.day(tag, day);
                    }
                }
                tags_of.borrow_mut()[i] = tags.into_iter().collect();
                Ok(())
            }
        })
        .await?;
        Ok(tags_of.into_inner())
    }

    /// Has both tiers hold each of these summaries, writing whichever lacks one. Each is
    /// looked at once a run, however many tags and chunks its content is in. Returns what went
    /// wrong, by content, for those that couldn't be.
    pub(crate) async fn ensure(&self, summaries: &[Summary]) -> HashMap<String, String> {
        use futures::FutureExt;

        let wanted: IndexMap<&str, &Summary> = summaries.iter().map(|summary| (summary.content_id.as_str(), summary)).collect();
        let fresh: Vec<Summary> = {
            let ensured = self.ensured.borrow();
            wanted
                .values()
                .filter(|summary| !ensured.contains_key(&summary.content_id))
                .map(|summary| (*summary).clone())
                .collect()
        };
        if !fresh.is_empty() {
            let ids: Vec<String> = fresh.iter().map(|summary| summary.content_id.clone()).collect();
            let store = self.deps.summaries.clone();
            let done: Ensuring = async move {
                let failures = match store.ensure_many(&fresh).await {
                    Ok(failures) => failures.into_iter().map(|failure| failure.map(|err| format!("{err:#}"))).collect(),
                    Err(err) => vec![Some(format!("{err:#}")); fresh.len()],
                };
                Rc::new(failures)
            }
            .boxed_local()
            .shared();
            let mut ensured = self.ensured.borrow_mut();
            for (i, id) in ids.into_iter().enumerate() {
                ensured.insert(id, (done.clone(), i));
            }
        }
        let mut lacking = HashMap::new();
        for id in wanted.keys() {
            let Some((done, i)) = self.ensured.borrow().get(*id).cloned() else { continue };
            if let Some(Some(failure)) = done.await.get(i) {
                lacking.insert((*id).to_owned(), failure.clone());
            }
        }
        lacking
    }
}
