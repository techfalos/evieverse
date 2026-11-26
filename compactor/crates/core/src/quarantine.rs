//! The quarantine: where the server keeps the files that matched the pdq trust plugin's list
//! of hashes of known child sexual abuse material, on a server whose operator turned it on
//! (QUARANTINE_SCHEME). This side writes it (a file that matched is kept, and one whose time
//! is over is deleted); an admin reads it through the API (src/quarantine.ts), which keeps
//! the same rows and the same objects.
//!
//! - A store of its own (`quarantine.scheme`, `quarantine.options`), which nothing else is
//!   written to, and nothing is served from.
//! - Every access is recorded (`quarantine_access`): that the file was kept, each time an
//!   admin read it, the report an admin recorded, and its deletion. The row is written before
//!   the thing is done, and stays when the item is gone.
//! - A file is deleted `quarantine.retentionDays` after its report, by the compactor, once a
//!   day (`expire_quarantine`). One that no admin has recorded a report of is not deleted by
//!   the server: an admin dismisses it, if it is not what the list took it for.
//!
//! The server reports nothing to anyone itself, and sends no file anywhere.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::config::Config;
use crate::db::{Db, Queries, is_unique_violation};
use crate::log::{self, Logger};
use crate::object::ObjectStore;
use crate::params;
use crate::time::{DAY, iso};

/// The quarantine's store of each configuration that was asked for: a store is opened once.
static STORES: Mutex<Option<HashMap<String, ObjectStore>>> = Mutex::new(None);

/// The object a quarantined file is, by its item's id.
fn file_key(id: &str) -> String {
    format!("files/{id}")
}

/// Whether the server keeps the files that match: whether its configuration names a store
/// for them.
pub fn quarantines(config: &Config) -> bool {
    config.quarantine.scheme.is_some()
}

/// The quarantine's store, or none on a server that has none.
fn store_of(config: &Config) -> Result<Option<ObjectStore>> {
    let Some(named) = config.quarantine_store() else { return Ok(None) };
    let key = serde_json::to_string(&named)?;
    let mut stores = STORES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let stores = stores.get_or_insert_with(HashMap::new);
    if let Some(store) = stores.get(&key) {
        return Ok(Some(store.clone()));
    }
    let store = ObjectStore::open(&named.scheme, &named.options).context("could not open the quarantine's store (QUARANTINE_SCHEME, QUARANTINE_OPTIONS)")?;
    stores.insert(key, store.clone());
    Ok(Some(store))
}

/// Who did something with an item: an admin, and where their request came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: String,
    pub ip: String,
    pub user_agent: Option<String>,
}

/// The first `most` characters of a text, as the API counts and cuts them: in UTF-16 units.
fn cut(text: &str, most: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= most
        })
        .collect()
}

/// Writes a row of the quarantine's log: what was done with an item, when, and by whom
/// (nobody, where the server did it itself).
pub async fn record_access(db: &mut impl Queries, quarantine_id: &str, action: &str, at: i64, actor: Option<&Actor>) -> Result<()> {
    db.execute(
        "INSERT INTO quarantine_access (id, quarantine_id, action, user_id, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            uuid::Uuid::new_v4().to_string(),
            quarantine_id,
            action,
            actor.map(|actor| actor.user_id.clone()),
            actor.map(|actor| cut(&actor.ip, 64)),
            actor.and_then(|actor| actor.user_agent.as_deref()).map(|agent| cut(agent, 255)),
            at
        ],
    )
    .await?;
    Ok(())
}

/// A file to keep in the quarantine, as whatever found the match gives it.
pub struct QuarantineFile<'a> {
    /// Who sent it.
    pub user_id: &'a str,
    /// The file on this machine that holds it.
    pub path: &'a Path,
    /// Its SHA-256, in hex.
    pub sha256: &'a str,
    /// What it was sent as.
    pub mime_type: &'a str,
    /// What the admins are told of the match, as JSON.
    pub facts: &'a Value,
}

/// The item the file already is, counted once more; none if it is none yet.
async fn again(db: &Db, user_id: &str, sha256: &str, at: i64) -> Result<Option<String>> {
    let Some(kept) = db
        .fetch_optional("SELECT id FROM quarantine WHERE user_id = ? AND sha256 = ?", params![user_id, sha256])
        .await?
    else {
        return Ok(None);
    };
    let id = kept.string("id")?;
    db.execute(
        "UPDATE quarantine SET matches = matches + 1, last_matched_at = ? WHERE id = ?",
        params![at, &id],
    )
    .await?;
    Ok(Some(id))
}

/// Keeps a file that matched, and returns the id of its item; none on a server that has no
/// quarantine. The file is written first, under an id nothing names yet, and then its row: a
/// file whose row couldn't be written is deleted again. A file the same user sent before is
/// the item it already is, which counts one more match.
///
/// It fails if the file can't be kept. Whoever calls it is refusing the file whatever becomes
/// of this, and says so in the log.
pub async fn quarantine_file(db: &Db, config: &Config, at: i64, file: &QuarantineFile<'_>) -> Result<Option<String>> {
    let Some(store) = store_of(config)? else { return Ok(None) };
    if let Some(kept) = again(db, file.user_id, file.sha256, at).await? {
        return Ok(Some(kept));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let size = tokio::fs::metadata(file.path)
        .await
        .with_context(|| format!("could not look at {}", file.path.display()))?
        .len();
    // As bytes, whatever it was sent as: nothing that reads the store is to show it.
    store.write_file(&file_key(&id), file.path, "application/octet-stream").await?;
    let written = async {
        let mut tx = db.begin().await?;
        tx.execute(
            "INSERT INTO quarantine (id, user_id, sha256, mime_type, size, facts, created_at, last_matched_at, reported_at, reported_by, report_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)",
            params![&id, file.user_id, file.sha256, cut(file.mime_type, 255), i64::try_from(size).unwrap_or(i64::MAX), file.facts.to_string(), at, at],
        )
        .await?;
        record_access(&mut tx, &id, "stored", at, None).await?;
        tx.commit().await
    }
    .await;
    if let Err(err) = written {
        let _ = store.delete(&file_key(&id)).await;
        // The same file, sent twice at once: the other request kept it.
        if is_unique_violation(&err)
            && let Some(other) = again(db, file.user_id, file.sha256, at).await?
        {
            return Ok(Some(other));
        }
        return Err(err);
    }
    Ok(Some(id))
}

/// Deletes an item: its file, and then its row. Recorded first, as `action` (an admin's
/// dismissal, or the end of its time), so the log says it of a deletion that stopped halfway
/// too, which is then made again. A file that is already gone is no error.
pub async fn remove_quarantined(db: &Db, config: &Config, at: i64, id: &str, action: &str, actor: Option<&Actor>) -> Result<()> {
    let Some(store) = store_of(config)? else {
        bail!("this server has no quarantine (QUARANTINE_SCHEME)")
    };
    record_access(&mut &*db, id, action, at, actor).await?;
    store.delete(&file_key(id)).await?;
    db.execute("DELETE FROM quarantine WHERE id = ?", params![id]).await?;
    Ok(())
}

/// Deletes the files whose time is over: those an admin recorded a report of
/// `quarantine.retentionDays` ago or longer, counted from the time of the report. The
/// compactor calls it, once a day. One that can't be deleted is logged, and tried again the
/// next day.
///
/// A file nobody recorded a report of is never deleted here, however old: deleting what may
/// yet have to be reported is not the server's to decide. The log is told how many wait, each
/// day, until an admin has reported or dismissed them.
///
/// Does nothing on a server that has no quarantine.
pub async fn expire_quarantine(db: &Db, config: &Config, now: i64, log: &Logger) -> Result<()> {
    if !quarantines(config) {
        return Ok(());
    }
    let days = config.quarantine.retention_days;
    let due = db
        .fetch("SELECT id, reported_at FROM quarantine WHERE reported_at <= ?", params![now - days * DAY])
        .await?;
    for row in due {
        let (id, reported_at) = (row.string("id")?, row.i64("reported_at")?);
        match remove_quarantined(db, config, now, &id, "expired", None).await {
            Ok(()) => log.info(
                json!({ "quarantineId": id, "reportedAt": iso(reported_at), "days": days }),
                "deleted a quarantined file: the time it is kept for after its report is over",
            ),
            Err(err) => log.error(
                json!({ "err": log::err(&err), "quarantineId": id }),
                "could not delete a quarantined file whose time is over; it is tried again tomorrow",
            ),
        }
    }
    let waiting = db
        .fetch_optional("SELECT COUNT(*) AS waiting FROM quarantine WHERE reported_at IS NULL", &[])
        .await?
        .map_or(Ok(0), |row| row.i64("waiting"))?;
    if waiting > 0 {
        log.warn(
            json!({ "files": waiting }),
            "the quarantine holds files that matched the list of hashes of known child sexual abuse material and that no admin has recorded a report of, or dismissed: GET /moderation/quarantine?reported=false lists them",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    #[tokio::test]
    async fn keeps_a_file_once_counts_it_again_and_deletes_it_when_its_time_is_over() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        let root = dir.path().join("quarantine");
        let config = testing::config(
            dir.path(),
            json!({ "quarantine": { "scheme": "fs", "options": { "root": root.to_string_lossy() }, "retentionDays": 90 } }),
        );
        let none = testing::config(dir.path(), json!({}));
        let sent = dir.path().join("sent.jpg");
        std::fs::write(&sent, b"the bytes of it").unwrap();
        let facts = json!({ "userId": "u1", "listed": "ab" });
        let file = QuarantineFile {
            user_id: "u1",
            path: &sent,
            sha256: "s1",
            mime_type: "image/jpeg",
            facts: &facts,
        };

        assert_eq!(quarantine_file(&db, &none, 1000, &file).await.unwrap(), None);
        let id = quarantine_file(&db, &config, 1000, &file).await.unwrap().unwrap();
        assert_eq!(std::fs::read(root.join("files").join(&id)).unwrap(), b"the bytes of it");
        assert_eq!(quarantine_file(&db, &config, 2000, &file).await.unwrap().as_deref(), Some(id.as_str()));
        let row = db.fetch_optional("SELECT * FROM quarantine", &[]).await.unwrap().unwrap();
        assert_eq!(
            (
                row.i64("matches").unwrap(),
                row.i64("created_at").unwrap(),
                row.i64("last_matched_at").unwrap(),
                row.i64("size").unwrap()
            ),
            (2, 1000, 2000, 15)
        );
        assert_eq!(serde_json::from_str::<Value>(row.str("facts").unwrap()).unwrap(), facts);
        // Another user's, though the same file, is an item of its own.
        let other = quarantine_file(&db, &config, 3000, &QuarantineFile { user_id: "u2", ..file })
            .await
            .unwrap()
            .unwrap();
        assert_ne!(other, id);

        // Nothing is deleted that no report was recorded of, and the log is told what waits.
        let (log, said) = Logger::collecting();
        expire_quarantine(&db, &config, 400 * DAY, &log).await.unwrap();
        assert_eq!(db.fetch("SELECT id FROM quarantine", &[]).await.unwrap().len(), 2);
        assert_eq!(said.take().iter().map(|entry| entry.fields["files"].clone()).collect::<Vec<_>>(), [json!(2)]);

        db.execute("UPDATE quarantine SET reported_at = ? WHERE id = ?", params![10 * DAY, &id])
            .await
            .unwrap();
        expire_quarantine(&db, &config, 100 * DAY - 1, &log).await.unwrap();
        assert!(root.join("files").join(&id).exists());
        expire_quarantine(&db, &config, 100 * DAY, &log).await.unwrap();
        assert!(!root.join("files").join(&id).exists());
        assert!(root.join("files").join(&other).exists());
        let actions: Vec<String> = db
            .fetch("SELECT action FROM quarantine_access WHERE quarantine_id = ? ORDER BY created_at", params![&id])
            .await
            .unwrap()
            .iter()
            .map(|row| row.string("action").unwrap())
            .collect();
        assert_eq!(actions, ["stored", "expired"]);
        expire_quarantine(&db, &none, 100 * DAY, &log).await.unwrap();
    }
}
