//! Building the feed index: the part of a run that reads the tags' indexes, rebuilds the days
//! that changed, and swaps each tag's head to what it built.

use std::collections::{HashMap, HashSet};

use anyhow::{Result, anyhow};
use evieverse_core::content::ContentMeta;
use evieverse_core::db::{Value, places};
use evieverse_core::hot::HotEntry;
use evieverse_core::json::from_slice;
use evieverse_core::layout::{
    DayRef, Head, IndexEntry, LAYOUT_VERSION, Manifest, compare_recent, compare_records, day_key, day_quota, head_key, index_author, manifest_key, new_gen_id,
    new_manifest_id, pack_day, unpack_day,
};
use evieverse_core::reposts::repost_times;
use evieverse_core::summary::{Summary, summary_of};
use evieverse_core::time::{utc_day, whole_seconds};
use evieverse_core::util::map_limit;
use indexmap::{IndexMap, IndexSet};

use crate::lease::is_lease_lost;
use crate::rows::{BATCH, ContentRow, content_rows, values};
use crate::run::{META_READS, Run, TagWork};

/// About how many entries a run rebuilds together. The tags of a batch are taken a chunk at a
/// time, each chunk's days holding about that many between them, and a chunk is read, rebuilt
/// and published as one: it is what a run holds in memory, and what one round trip carries.
const CHUNK_WEIGHT: usize = 25_000;

/// What a day counts for in a chunk beside its entries: its keys are read and written with them.
const DAY_WEIGHT: usize = 8;

/// Where a piece of content is in an index, and what its entry there counts.
///
/// Content is in the index of each hashtag it carries and in its publisher's own from when it
/// was created, with all of its likes. A repost (`reposts`) places it elsewhere as a new post:
/// in the index of each hashtag the repost gave it, and in the reposter's own, from when it was
/// reposted, with the likes since. The time is the UTC day its entry is in, where feeds order
/// it, and what its retention is counted from: content older than the retention period is in
/// an index for as long as a repost that put it there is within it.
struct Placement {
    at: i64,
    /// The content's like count when it was placed: its entry counts the likes since.
    likes_before: i64,
    /// A repost placed it.
    repost: bool,
}

/// What hashtags' moderators decided about content under them, by `decided_key`.
type Decided = HashMap<String, String>;

/// A tag and a piece of content as one string, which `Decided` is keyed by.
fn decided_key(tag: &str, content_id: &str) -> String {
    format!("{tag} {content_id}")
}

/// One UTC day of a tag that a run rebuilds.
struct DayPlan {
    day: i64,
    /// The day's index as the tag's manifest names it, if it names one.
    prev: Option<DayRef>,
    quota: i64,
    recheck: IndexSet<String>,
    readmit: IndexSet<String>,
}

/// What a run does to one tag, worked out from its manifest before any of its day indexes is
/// read.
struct TagPlan {
    tag: String,
    /// The publisher whose own index this is; none for a hashtag.
    author: Option<String>,
    /// The manifest its head names; none for a tag with none.
    manifest: Option<Manifest>,
    /// Days the next manifest names as they are.
    carried: Vec<DayRef>,
    days: Vec<DayPlan>,
    /// About how many entries its days hold, which is what chunks are sized by.
    weight: usize,
}

/// A day as a chunk rebuilds it.
struct DayBuild {
    plan: DayPlan,
    /// The day's index as it is.
    before: Option<Vec<u8>>,
    /// The entries it holds of content that isn't rechecked, to be refreshed.
    held: Vec<IndexEntry>,
    /// Content to build an entry for from the database and its meta file.
    build: Vec<String>,
    entries: Vec<IndexEntry>,
}

/// A tag as a chunk rebuilds it: `compact_chunk` fills in its days' entries, and `pack` makes
/// its `Publication` of them.
struct TagBuild {
    plan: TagPlan,
    days: Vec<DayBuild>,
    /// The summaries of the content it built entries for, which both tiers must hold before
    /// it is published.
    summaries: Vec<Summary>,
}

/// A tag's new index, ready to be published.
struct Publication {
    tag: String,
    /// The manifest it replaces.
    previous: Option<Manifest>,
    next: Manifest,
    /// The day indexes that came out different, and the manifest: each key with what it holds.
    writes: Vec<(String, Vec<u8>)>,
}

/// The tags of a batch in chunks of about CHUNK_WEIGHT entries; a tag that holds more is a
/// chunk of its own.
fn chunks_of(plans: Vec<TagPlan>) -> Vec<Vec<TagPlan>> {
    let mut chunks = Vec::new();
    let mut chunk: Vec<TagPlan> = Vec::new();
    let mut weight = 0;
    for plan in plans {
        if !chunk.is_empty() && weight + plan.weight > CHUNK_WEIGHT {
            chunks.push(std::mem::take(&mut chunk));
            weight = 0;
        }
        weight += plan.weight;
        chunk.push(plan);
    }
    if !chunk.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

/// A day to rebuild, from its current index: the entries it holds of content that isn't
/// rechecked, and the content to build an entry for, which is what is rechecked, whether the
/// day holds it or not, and what is re-admitted, if it doesn't.
fn open_day(plan: DayPlan, before: Option<Vec<u8>>) -> DayBuild {
    let mut held: IndexMap<String, IndexEntry> = IndexMap::new();
    if let Some(before) = &before {
        for entry in unpack_day(before) {
            held.insert(entry.content_id.clone(), entry);
        }
    }
    for id in &plan.recheck {
        held.shift_remove(id);
    }
    let readmitted = plan.readmit.iter().filter(|id| !held.contains_key(*id) && !plan.recheck.contains(*id));
    let build = plan.recheck.iter().chain(readmitted).cloned().collect();
    DayBuild {
        before,
        held: held.into_values().collect(),
        build,
        entries: Vec::new(),
        plan,
    }
}

/// Whether the content's entry in a hashtag's index is flagged as moderated: its moderators
/// approved it. None if they removed the hashtag from the content, which then has no entry
/// there.
fn moderated(tag: &str, id: &str, decided: &Decided) -> Option<bool> {
    match decided.get(&decided_key(tag, id)).map(String::as_str) {
        Some("removed") => None,
        decision => Some(decision == Some("approved")),
    }
}

/// Sorts one day's entries by likes, then recency (a publisher's own index: by recency
/// alone), and keeps the first `quota` of them. Creation times are cut to the whole seconds
/// an index stores first, so the index order is the order readers see.
fn trim(entries: &[IndexEntry], quota: i64, newest_first: bool) -> Vec<IndexEntry> {
    let mut kept: Vec<IndexEntry> = entries
        .iter()
        .map(|entry| IndexEntry {
            created_at: whole_seconds(entry.created_at),
            ..entry.clone()
        })
        .collect();
    kept.sort_by(if newest_first { compare_recent } else { compare_records });
    kept.truncate(usize::try_from(quota).unwrap_or(0));
    kept
}

impl Run<'_> {
    /// Compacts a batch of tags together, so that what it costs in round trips doesn't grow
    /// with the tags: their heads are read in one, their manifests in another, and then, a
    /// chunk at a time (see `chunks_of`), their day indexes, the rows and the moderators'
    /// decisions of all the content those hold, and the summaries of what is rebuilt; and the
    /// new day indexes and manifests are written in one, made to last in one, and the heads
    /// swapped in one.
    ///
    /// A tag fails on its own where what went wrong is its own (its manifest or a day index is
    /// missing, a meta file or a summary it needs can't be read or written, part of its new
    /// index was evicted): the rest of its chunk is published without it. A round trip that
    /// fails takes its whole chunk, or batch, with it. Either way the tags are recorded as
    /// failed, and their heads are as they were.
    pub(crate) async fn compact_batch(&self, tags: &[String], work: &IndexMap<String, TagWork>) -> Result<()> {
        let plans = match self.open(tags, work).await {
            Ok(plans) => plans,
            Err(err) if is_lease_lost(&err) => return Err(err),
            Err(err) => {
                self.fail(tags, &err);
                return Ok(());
            }
        };
        for chunk in chunks_of(plans) {
            let tags: Vec<String> = chunk.iter().map(|plan| plan.tag.clone()).collect();
            match self.compact_chunk(chunk).await {
                Err(err) if is_lease_lost(&err) => return Err(err),
                Err(err) => self.fail(&tags, &err),
                Ok(()) => {}
            }
        }
        Ok(())
    }

    /// Reads the tags' heads and the manifests they name, and plans each tag's work from its
    /// manifest.
    async fn open(&self, tags: &[String], work: &IndexMap<String, TagWork>) -> Result<Vec<TagPlan>> {
        let hot = &self.deps.hot;
        // A tag that was never compacted has no head, and reads as empty.
        let heads = hot
            .mget(&tags.iter().map(|tag| head_key(tag)).collect::<Vec<String>>())
            .await?
            .into_iter()
            .map(|head| head.map_or_else(|| Ok(Head::empty()), |head| from_slice::<Head>(&head)))
            .collect::<serde_json::Result<Vec<Head>>>()?;
        let named: Vec<String> = tags
            .iter()
            .zip(&heads)
            .filter_map(|(tag, head)| head.manifest.as_ref().map(|id| manifest_key(tag, id)))
            .collect();
        let mut manifests = hot.mget(&named).await?.into_iter();
        let none = TagWork::default();
        let mut plans = Vec::with_capacity(tags.len());
        for (tag, head) in tags.iter().zip(&heads) {
            let manifest = match &head.manifest {
                Some(_) => manifests.next().flatten(),
                None => None,
            };
            if let Some(id) = &head.manifest
                && manifest.is_none()
                && !self.rebuild
            {
                self.fail(std::slice::from_ref(tag), &anyhow!("manifest {id} of #{tag} is missing"));
                continue;
            }
            let manifest = manifest.map(|manifest| from_slice::<Manifest>(&manifest)).transpose()?;
            plans.push(self.plan(tag, work.get(tag).unwrap_or(&none), manifest));
        }
        Ok(plans)
    }

    /// What to do to a tag: rebuild the days `work` names and those whose quota has shrunk,
    /// carry the others over as they are, and drop those past retention.
    fn plan(&self, tag: &str, work: &TagWork, manifest: Option<Manifest>) -> TagPlan {
        let feed = &self.deps.config.feed;
        let today = utc_day(self.run_start);
        let min_day = today - self.retention_days() + 1;
        let author = index_author(tag).map(str::to_owned);
        let quota_of = |day: i64| {
            if author.is_some() {
                feed.author_day_max_posts
            } else {
                day_quota(today - day, feed.tag_day_max_posts, feed.tag_day_min_posts)
            }
        };

        let existing: IndexMap<i64, &DayRef> = manifest.iter().flat_map(|manifest| &manifest.days).map(|day| (day.day, day)).collect();
        let mut rebuild: IndexSet<i64> = work.days.clone();
        for day in existing.values() {
            if work.all || day.quota > quota_of(day.day) {
                rebuild.insert(day.day);
            }
        }

        let days: Vec<DayPlan> = rebuild
            .iter()
            .filter(|day| **day >= min_day)
            .map(|day| DayPlan {
                day: *day,
                prev: existing.get(day).map(|prev| (*prev).clone()),
                quota: quota_of(*day),
                recheck: work.recheck.get(day).cloned().unwrap_or_default(),
                readmit: work.readmit.get(day).cloned().unwrap_or_default(),
            })
            .collect();
        let carried: Vec<DayRef> = existing
            .values()
            .filter(|day| day.day >= min_day && !rebuild.contains(&day.day))
            .map(|day| (*day).clone())
            .collect();
        let weight = days
            .iter()
            .map(|day| {
                let held = day.prev.as_ref().map_or(0, |prev| usize::try_from(prev.count).unwrap_or(0));
                DAY_WEIGHT + held + day.recheck.len() + day.readmit.len()
            })
            .sum();
        TagPlan {
            tag: tag.to_owned(),
            author,
            manifest,
            carried,
            days,
            weight,
        }
    }

    /// Rebuilds the days of a chunk of tags, and swaps each tag's head to a manifest of them
    /// and of the days carried over. A tag none of whose days came out any different keeps its
    /// head, and nothing is written for it.
    async fn compact_chunk(&self, plans: Vec<TagPlan>) -> Result<()> {
        let hot = &self.deps.hot;

        // The day indexes to rebuild, as they are.
        let keys: Vec<String> = plans
            .iter()
            .flat_map(|plan| {
                let named = plan.days.iter().filter_map(|day| day.prev.as_ref());
                named.map(|prev| day_key(&plan.tag, &prev.generation))
            })
            .collect();
        let mut current = hot.mget(&keys).await?.into_iter();
        let mut tags: Vec<TagBuild> = Vec::with_capacity(plans.len());
        for mut plan in plans {
            let before: Vec<Option<Vec<u8>>> = plan
                .days
                .iter()
                .map(|day| if day.prev.is_some() { current.next().flatten() } else { None })
                .collect();
            let lost = plan
                .days
                .iter()
                .zip(&before)
                .find_map(|(day, before)| day.prev.as_ref().filter(|_| before.is_none()));
            if let Some(lost) = lost
                && !self.rebuild
            {
                let missing = anyhow!("day index {} of #{} is missing", lost.generation, plan.tag);
                self.fail(std::slice::from_ref(&plan.tag), &missing);
                continue;
            }
            let days = std::mem::take(&mut plan.days)
                .into_iter()
                .zip(before)
                .map(|(day, before)| open_day(day, before))
                .collect();
            tags.push(TagBuild {
                plan,
                days,
                summaries: Vec::new(),
            });
        }

        // What the database says of all the content those days hold or may come to, and what moderators decided about it.
        let mut ids: IndexSet<&String> = IndexSet::new();
        let mut under_hashtags: IndexSet<&String> = IndexSet::new();
        // The content that is rebuilt, and what the days hold because of a repost.
        let mut building: IndexSet<&String> = IndexSet::new();
        let mut reposted: Vec<&String> = Vec::new();
        for tag in &tags {
            for day in &tag.days {
                for id in day.held.iter().map(|entry| &entry.content_id).chain(&day.build) {
                    ids.insert(id);
                    if tag.plan.author.is_none() {
                        under_hashtags.insert(id);
                    }
                }
                building.extend(&day.build);
                reposted.extend(day.held.iter().filter(|entry| entry.repost).map(|entry| &entry.content_id));
            }
        }
        let ids: Vec<String> = ids.into_iter().cloned().collect();
        let rows = content_rows(&self.deps.db, &ids).await?;
        let hashtags: Vec<&String> = tags.iter().filter(|tag| tag.plan.author.is_none()).map(|tag| &tag.plan.tag).collect();
        let decided = self.decisions(&hashtags, &under_hashtags.into_iter().collect::<Vec<_>>()).await?;
        // Where reposts placed what is rebuilt, and what the days hold because of one.
        self.places.load(building.iter().copied().chain(reposted)).await?;
        // The meta files of what is rebuilt: read already, unless the run that marked the content couldn't.
        let readable: Vec<&String> = building.iter().copied().filter(|id| self.indexable(rows.get(*id))).collect();
        map_limit(readable, META_READS, |id| async move {
            let _ = self.meta(id).await;
            Ok(())
        })
        .await?;

        // Each day's entries: those it holds, refreshed, and those rebuilt.
        let mut built: Vec<TagBuild> = Vec::with_capacity(tags.len());
        for mut tag in tags {
            let TagBuild { plan, days, summaries } = &mut tag;
            let building = async {
                for day in days.iter_mut() {
                    day.entries = self.refreshed(&plan.tag, &day.held, &rows, &decided);
                    for id in &day.build {
                        if let Some((entry, summary)) = self.rebuilt(plan, day.plan.day, rows.get(id), &decided).await? {
                            day.entries.push(entry);
                            summaries.push(summary);
                        }
                    }
                }
                Ok(())
            }
            .await;
            match building {
                Ok(()) => built.push(tag),
                Err(err) => self.fail(std::slice::from_ref(&tag.plan.tag), &err),
            }
        }

        // A rebuilt entry's summary is in both tiers before a feed can list it.
        let wanted: Vec<Summary> = built.iter().flat_map(|tag| tag.summaries.iter().cloned()).collect();
        let lacking = self.ensure(&wanted).await;
        let mut publishing: Vec<Publication> = Vec::new();
        for tag in &built {
            if let Some(failure) = tag.summaries.iter().find_map(|summary| lacking.get(&summary.content_id)) {
                self.fail(std::slice::from_ref(&tag.plan.tag), &anyhow!("{failure}"));
                continue;
            }
            match self.pack(tag) {
                Ok(Some(publication)) => publishing.push(publication),
                Ok(None) => {}
                Err(err) => self.fail(std::slice::from_ref(&tag.plan.tag), &err),
            }
        }
        if publishing.is_empty() {
            return Ok(());
        }

        let keys: Vec<String> = publishing
            .iter()
            .flat_map(|publication| publication.writes.iter().map(|(key, _)| key.clone()))
            .collect();
        let provisional: Vec<HotEntry> = publishing
            .iter()
            .flat_map(|publication| &publication.writes)
            .map(|(key, value)| HotEntry {
                key: key.clone(),
                value: value.clone(),
                ttl_ms: Some(self.provisional_ms()),
            })
            .collect();
        let persisting = async {
            // Provisional until the heads are swapped: a run killed at any point before leaves nothing for good.
            hot.set_many(&provisional).await?;
            self.lease.check().await?;
            // Now it is made to last, and the heads swapped to it straight after.
            hot.persist(&keys).await
        }
        .await;
        let kept = match persisting {
            Ok(kept) => kept,
            Err(err) => {
                // No head references these yet.
                let _ = hot.del(&keys).await;
                return Err(err);
            }
        };
        let mut kept = kept.into_iter();
        let mut evicted: Vec<String> = Vec::new();
        let mut published: Vec<Publication> = Vec::with_capacity(publishing.len());
        for publication in publishing {
            let there: Vec<bool> = kept.by_ref().take(publication.writes.len()).collect();
            if there.len() == publication.writes.len() && there.iter().all(|there| *there) {
                published.push(publication);
                continue;
            }
            evicted.extend(publication.writes.iter().map(|(key, _)| key.clone()));
            let missing = anyhow!(
                "part of the new index of #{} expired or was evicted before its head was swapped",
                publication.tag
            );
            self.fail(std::slice::from_ref(&publication.tag), &missing);
        }
        if !evicted.is_empty() {
            let _ = hot.del(&evicted).await;
        }
        let heads = published
            .iter()
            .map(|publication| {
                let head = Head {
                    v: LAYOUT_VERSION,
                    manifest: Some(publication.next.id.clone()),
                    compacted_at: self.run_start,
                };
                Ok(HotEntry {
                    key: head_key(&publication.tag),
                    value: serde_json::to_vec(&head)?,
                    ttl_ms: None,
                })
            })
            .collect::<Result<Vec<HotEntry>>>()?;
        hot.set_many(&heads).await?;

        // Requests that read the previous heads, from a node's cache or just before the swap, still find their keys.
        let mut superseded: Vec<String> = Vec::new();
        for publication in &published {
            let Some(previous) = &publication.previous else { continue };
            let used: HashSet<&str> = publication.next.days.iter().map(|day| day.generation.as_str()).collect();
            let unused = previous.days.iter().filter(|day| !used.contains(day.generation.as_str()));
            superseded.extend(unused.map(|day| day_key(&publication.tag, &day.generation)));
            superseded.push(manifest_key(&publication.tag, &previous.id));
        }
        hot.expire(&superseded, self.keep_ms()).await
    }

    /// What these hashtags' moderators decided about these pieces of content under them. A
    /// publisher's own index has no moderators.
    async fn decisions(&self, hashtags: &[&String], ids: &[&String]) -> Result<Decided> {
        let mut decided = Decided::new();
        if hashtags.is_empty() {
            return Ok(decided);
        }
        for batch in ids.chunks(BATCH) {
            let mut params: Vec<Value> = values(batch.iter().copied());
            params.extend(values(hashtags.iter().copied()));
            let rows = self
                .deps
                .db
                .fetch(
                    &format!(
                        "SELECT content_id, tag, decision FROM tag_moderation WHERE content_id IN ({}) AND tag IN ({})",
                        places(batch.len()),
                        places(hashtags.len())
                    ),
                    &params,
                )
                .await?;
            for row in &rows {
                decided.insert(decided_key(row.str("tag")?, row.str("content_id")?), row.string("decision")?);
            }
        }
        Ok(decided)
    }

    /// Whether an index can hold the content at all: it is there, not set for deletion, not
    /// withheld (waiting in the moderation queue, or an entry whose original is gone from its
    /// own server), and within retention, which content older than that is for as long as a
    /// repost of it is (see `Placement`).
    fn indexable(&self, row: Option<&ContentRow>) -> bool {
        let Some(row) = row.filter(|row| !row.deleting() && !row.withheld()) else {
            return false;
        };
        let oldest = self.oldest();
        row.created_at > oldest || self.places.of(&row.id).iter().any(|place| place.created_at > oldest)
    }

    /// Where the content is in an index, or none if it isn't there: see `Placement`. In a
    /// hashtag's index it is there if it carries the hashtag, which for a hashtag a repost
    /// gave it is once a run has written it to the meta file (see `apply_reposts`). In a
    /// user's own index it is there if it is theirs, or they reposted it.
    fn placement(&self, plan: &TagPlan, row: &ContentRow, meta: &ContentMeta) -> Option<Placement> {
        let own = Placement {
            at: row.created_at,
            likes_before: 0,
            repost: false,
        };
        match &plan.author {
            Some(author) if *author == row.user_id => return Some(own),
            None if !meta.tags.contains(&plan.tag) => return None,
            _ => {}
        }
        if let Some(place) = self.places.of(&row.id).iter().find(|place| place.tag == plan.tag) {
            return Some(Placement {
                at: place.created_at,
                likes_before: place.likes_before,
                repost: true,
            });
        }
        plan.author.is_none().then_some(own)
    }

    /// The entries a day holds, with current likes, the AI flag and, in a hashtag's index,
    /// what its moderators decided, from the database: content they approved is flagged as
    /// moderated, and content they removed the hashtag from is dropped. So is content that is
    /// deleted, set for deletion, past retention, or withheld.
    ///
    /// An entry a repost made counts the likes since the repost, and is dropped if the
    /// repost's place in this index is no more: the reposter's account is gone, or the place
    /// was given again since, which is another entry.
    fn refreshed(&self, tag: &str, entries: &[IndexEntry], rows: &HashMap<String, ContentRow>, decided: &Decided) -> Vec<IndexEntry> {
        let oldest = self.oldest();
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(row) = rows.get(&entry.content_id) else { continue };
            if row.deleting() || row.withheld() || entry.created_at <= oldest {
                continue;
            }
            let mut likes = row.like_count;
            if entry.repost {
                let placed = self.places.of(&entry.content_id);
                let Some(place) = placed.iter().find(|place| place.tag == tag) else {
                    continue;
                };
                if whole_seconds(place.created_at) != entry.created_at {
                    continue;
                }
                likes = (likes - place.likes_before).max(0);
            }
            let Some(moderated) = moderated(tag, &entry.content_id, decided) else {
                continue;
            };
            out.push(IndexEntry {
                likes,
                ai_generated: row.ai_generated,
                moderated,
                ..entry.clone()
            });
        }
        out
    }

    /// An entry rebuilt from the database and the content's meta file, with the summary it is
    /// shown by: for the content of the feed queue's rows, which is how every write reaches
    /// the index, and for liked content an earlier compaction trimmed. None for content no
    /// index can hold (see `indexable`), that has no place in this one (see `placement`: it
    /// doesn't carry the tag, or in a user's own index is neither theirs nor reposted by
    /// them), whose place is in another day than `day` or past retention, or that a moderator
    /// removed the tag from. It then competes for the day's quota like any entry.
    async fn rebuilt(&self, plan: &TagPlan, day: i64, row: Option<&ContentRow>, decided: &Decided) -> Result<Option<(IndexEntry, Summary)>> {
        let Some(row) = row.filter(|row| self.indexable(Some(row))) else {
            return Ok(None);
        };
        let Some(meta) = self.meta(&row.id).await? else { return Ok(None) };
        let Some(place) = self.placement(plan, row, &meta) else { return Ok(None) };
        if utc_day(place.at) != day || place.at <= self.oldest() {
            return Ok(None);
        }
        let Some(moderated) = moderated(&plan.tag, &row.id, decided) else {
            return Ok(None);
        };
        let reposted_at = repost_times(&self.places.of(&row.id));
        let summary = summary_of(row.posted(), &meta, &self.deps.config.public_base_url, &reposted_at);
        let entry = IndexEntry {
            content_id: row.id.clone(),
            created_at: place.at,
            likes: (row.like_count - place.likes_before).max(0),
            ai_generated: summary.ai_generated,
            moderated,
            repost: place.repost,
        };
        Ok(Some((entry, summary)))
    }

    /// A tag's days, each trimmed to its quota and packed, and the manifest that names them
    /// with the days carried over. A day that came out exactly as it is keeps its index, so an
    /// update that changed nothing the index holds leaves no superseded key behind; none if
    /// every day did, when there is nothing to publish.
    fn pack(&self, build: &TagBuild) -> Result<Option<Publication>> {
        let plan = &build.plan;
        let mut days = plan.carried.clone();
        let mut writes: Vec<(String, Vec<u8>)> = Vec::new();
        for day in &build.days {
            let DayPlan { day: number, prev, quota, .. } = &day.plan;
            let kept = trim(&day.entries, *quota, plan.author.is_some());
            if kept.is_empty() {
                continue;
            }
            let packed = pack_day(&kept)?;
            if let (Some(prev), Some(before)) = (prev, &day.before)
                && prev.quota == *quota
                && packed == *before
            {
                days.push(prev.clone());
                continue;
            }
            let named = DayRef {
                day: *number,
                generation: new_gen_id(*number, self.run_start),
                quota: *quota,
                count: i64::try_from(kept.len()).unwrap_or(i64::MAX),
            };
            writes.push((day_key(&plan.tag, &named.generation), packed));
            days.push(named);
        }
        days.sort_by_key(|day| std::cmp::Reverse(day.day));
        if let Some(manifest) = &plan.manifest
            && days.len() == manifest.days.len()
            && days.iter().zip(&manifest.days).all(|(day, had)| day.generation == had.generation)
        {
            return Ok(None);
        }
        let next = Manifest {
            v: LAYOUT_VERSION,
            tag: plan.tag.clone(),
            id: new_manifest_id(self.run_start),
            created_at: self.run_start,
            days,
        };
        writes.push((manifest_key(&plan.tag, &next.id), serde_json::to_vec(&next)?));
        Ok(Some(Publication {
            tag: plan.tag.clone(),
            previous: plan.manifest.clone(),
            next,
            writes,
        }))
    }
}
