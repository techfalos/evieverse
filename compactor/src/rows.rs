//! The rows of the database a run reads of content, and the places reposts gave it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use evieverse_core::db::{Db, Row, Value, places};
use evieverse_core::reposts::Repost;
use evieverse_core::summary::Posted;
use indexmap::IndexSet;

/// The most values a run names in the `IN (...)` list of one database statement (content ids,
/// user ids, queue tokens), and the most hashtags or users it syncs to Redis between two
/// checks of its lease.
pub const BATCH: usize = 500;

/// The columns of a `ContentRow`, for a select from `content` joined to `moderation_queue`
/// (see `CONTENT_FROM`).
pub const CONTENT_COLUMNS: &str = "content.id, content.user_id, content.like_count, content.created_at, content.ai_generated, \
     content.delete_requested_at, content.origin_gone_at, moderation_queue.content_id AS queued_id";

/// What a select of `CONTENT_COLUMNS` reads from.
pub const CONTENT_FROM: &str = "content LEFT JOIN moderation_queue ON moderation_queue.content_id = content.id";

/// A piece of content as the database has it when a run reads it.
#[derive(Debug, Clone)]
pub struct ContentRow {
    pub id: String,
    pub user_id: String,
    pub like_count: i64,
    pub created_at: i64,
    pub ai_generated: bool,
    pub delete_requested_at: Option<i64>,
    /// Its id again, if it waits in the moderation queue.
    pub queued_id: Option<String>,
    /// On an entry for a post on another server: since when that server says the post is gone,
    /// if it does.
    pub origin_gone_at: Option<i64>,
}

impl ContentRow {
    /// The content of a row of `CONTENT_COLUMNS`.
    pub fn of(row: &Row) -> Result<Self> {
        Ok(Self {
            id: row.string("id")?,
            user_id: row.string("user_id")?,
            like_count: row.i64("like_count")?,
            created_at: row.i64("created_at")?,
            ai_generated: row.flag("ai_generated")?,
            delete_requested_at: row.opt_i64("delete_requested_at")?,
            queued_id: row.opt_string("queued_id")?,
            origin_gone_at: row.opt_i64("origin_gone_at")?,
        })
    }

    /// Whether content that is there is kept from readers. It is for one of two reasons: it
    /// waits in the moderation queue, or it is the server's entry for a post on another
    /// server, and that server says it publishes no post at the address, which it says of a
    /// post it deleted and of one that only waits in its own moderation queue. Either way the
    /// content has no summary and is in no index. It keeps its hashtags and the places
    /// reposts gave it, and is back in feeds with them once it is published again.
    pub fn withheld(&self) -> bool {
        self.queued_id.is_some() || self.origin_gone_at.is_some()
    }

    /// Whether the content is set for deletion: nothing more is written to it, and a run
    /// deletes it.
    pub fn deleting(&self) -> bool {
        self.delete_requested_at.is_some()
    }

    /// What a summary takes from the row.
    pub fn posted(&self) -> Posted<'_> {
        Posted {
            content_id: &self.id,
            user_id: &self.user_id,
            created_at: self.created_at,
            ai_generated: self.ai_generated,
        }
    }
}

/// The rows of these pieces of content, by id.
pub async fn content_rows(db: &Db, ids: &[String]) -> Result<HashMap<String, ContentRow>> {
    let mut out = HashMap::with_capacity(ids.len());
    for batch in ids.chunks(BATCH) {
        let params: Vec<Value> = batch.iter().map(Value::from).collect();
        let sql = format!("SELECT {CONTENT_COLUMNS} FROM {CONTENT_FROM} WHERE content.id IN ({})", places(batch.len()));
        for row in db.fetch(&sql, &params).await? {
            let row = ContentRow::of(&row)?;
            out.insert(row.id.clone(), row);
        }
    }
    Ok(out)
}

/// The values of a list, for the places of a statement.
pub fn values<'a>(of: impl IntoIterator<Item = &'a String>) -> Vec<Value> {
    of.into_iter().map(Value::from).collect()
}

/// The places reposts gave content (`reposts`), by content, as a run reads them: once for
/// each piece of content, however many tags it is in. Without the places the run takes away
/// (`gone`).
pub struct Places {
    db: Db,
    read: Mutex<HashMap<String, Arc<Vec<Repost>>>>,
    /// The places in the own index of a reposter whose account is gone, by tag and content:
    /// they count as not there.
    gone: Mutex<HashSet<(String, String)>>,
}

impl Places {
    /// The places of a run that has read none yet.
    pub fn new(db: Db) -> Self {
        Self {
            db,
            read: Mutex::new(HashMap::new()),
            gone: Mutex::new(HashSet::new()),
        }
    }

    fn read(&self) -> MutexGuard<'_, HashMap<String, Arc<Vec<Repost>>>> {
        self.read.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn gone(&self) -> MutexGuard<'_, HashSet<(String, String)>> {
        self.gone.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Has the place of `content_id` in the index `tag` count as not there, for the places
    /// read from now on.
    pub fn take_away(&self, tag: &str, content_id: &str) {
        self.gone().insert((tag.to_owned(), content_id.to_owned()));
    }

    /// Reads the places reposts gave these pieces of content, for the rest of the run: those
    /// of content it has read already are not read again.
    pub async fn load<'a>(&self, ids: impl IntoIterator<Item = &'a String>) -> Result<()> {
        let fresh: Vec<&String> = {
            let read = self.read();
            ids.into_iter()
                .filter(|id| !read.contains_key(*id))
                .collect::<IndexSet<_>>()
                .into_iter()
                .collect()
        };
        for batch in fresh.chunks(BATCH) {
            let mut found: HashMap<&str, Vec<Repost>> = batch.iter().map(|id| (id.as_str(), Vec::new())).collect();
            // In the order `reposts_of` reads them, which is the order the content comes to carry the hashtags in.
            let sql = format!(
                "SELECT content_id, tag, user_id, likes_before, created_at FROM reposts WHERE content_id IN ({}) ORDER BY created_at, tag",
                places(batch.len())
            );
            let rows = self.db.fetch(&sql, &values(batch.iter().copied())).await?;
            {
                let gone = self.gone();
                for row in &rows {
                    let id = row.str("content_id")?;
                    let place = Repost::of(row)?;
                    if !gone.contains(&(place.tag.clone(), id.to_owned()))
                        && let Some(places) = found.get_mut(id)
                    {
                        places.push(place);
                    }
                }
            }
            let mut read = self.read();
            for (id, places) in found {
                read.insert(id.to_owned(), Arc::new(places));
            }
        }
        Ok(())
    }

    /// The places reposts gave the content, as this run read them (see `load`); none for
    /// content it didn't read them of.
    pub fn of(&self, content_id: &str) -> Arc<Vec<Repost>> {
        self.read().get(content_id).cloned().unwrap_or_default()
    }

    /// The places reposts gave the content, read now if this run hasn't read them.
    pub async fn placed(&self, content_id: &str) -> Result<Arc<Vec<Repost>>> {
        self.load([&content_id.to_owned()]).await?;
        Ok(self.of(content_id))
    }

    /// Forgets the places read of a piece of content, which are read again when next asked for.
    pub fn forget(&self, content_id: &str) {
        self.read().remove(content_id);
    }
}
