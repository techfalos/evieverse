//! Ending the time of hashtags' moderators who left them (see src/moderation/activity.ts).

use anyhow::Result;
use evieverse_core::content::ContentStore;
use evieverse_core::db::Db;
use evieverse_core::inbox::{Notice, notify};
use evieverse_core::log::Logger;
use evieverse_core::params;
use serde_json::json;

/// A moderator of a hashtag: the hashtag, and who moderates it.
#[derive(Debug, Clone)]
pub struct Moderator {
    pub tag: String,
    pub user_id: String,
}

/// Starts counting the moderators of whom nothing is known, from `at`: the rows that were
/// there before the server kept `acted_at`, which a migration left null. Returns how many
/// there were.
pub async fn start_counting(db: &Db, at: i64) -> Result<u64> {
    db.execute("UPDATE tag_moderators SET acted_at = ? WHERE acted_at IS NULL", params![at]).await
}

/// The moderators who did nothing as one on their hashtag since `before`, which are the
/// compactor's to retire, longest idle first: at most `limit` of them.
pub async fn idle_moderators(db: &Db, before: i64, limit: usize) -> Result<Vec<Moderator>> {
    db.fetch(
        "SELECT tag, user_id FROM tag_moderators WHERE acted_at <= ? ORDER BY acted_at, tag, user_id LIMIT ?",
        params![before, i64::try_from(limit).unwrap_or(i64::MAX)],
    )
    .await?
    .iter()
    .map(|row| {
        Ok(Moderator {
            tag: row.string("tag")?,
            user_id: row.string("user_id")?,
        })
    })
    .collect()
}

/// Ends the time of a moderator who did nothing as one on their hashtag since `before`, and
/// tells them. Only if that is still so: one who did something since the run read them stays,
/// as does one who is gone already. Returns whether it ended. `now` is when they are told.
pub async fn retire_moderator(db: &Db, content: &ContentStore, log: &Logger, now: i64, moderator: &Moderator, before: i64) -> Result<bool> {
    let Moderator { tag, user_id } = moderator;
    let retired = db
        .execute(
            "DELETE FROM tag_moderators WHERE tag = ? AND user_id = ? AND acted_at <= ?",
            params![tag, user_id, before],
        )
        .await?;
    if retired == 0 {
        return Ok(false);
    }
    log.info(
        json!({ "tag": tag, "userId": user_id }),
        "ended a moderator's time on a hashtag: they did nothing as its moderator for TAG_MODERATOR_INACTIVE_DAYS",
    );
    // Nobody did this to them: `by` is nobody's id.
    let notice = Notice {
        user_id,
        kind: "tag_moderator_lapsed",
        tag: Some(tag),
        ..Notice::default()
    };
    notify(db, content, now, &notice, log).await;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use evieverse_core::testing;

    use super::*;

    const ALICE: &str = "11111111-1111-4111-8111-111111111111";
    const BOB: &str = "22222222-2222-4222-8222-222222222222";
    const DAY: i64 = 24 * 3600 * 1000;

    /// Who moderates #cars, by their id.
    async fn moderators(db: &Db) -> Vec<String> {
        let rows = db
            .fetch("SELECT user_id FROM tag_moderators WHERE tag = ? ORDER BY user_id", params!["cars"])
            .await
            .unwrap();
        rows.iter().map(|row| row.string("user_id").unwrap()).collect()
    }

    /// The notices a user was left, as the kind and the hashtag of each.
    async fn told(db: &Db, user_id: &str) -> Vec<(String, Option<String>)> {
        let rows = db
            .fetch("SELECT kind, tag FROM inbox WHERE user_id = ? ORDER BY created_at", params![user_id])
            .await
            .unwrap();
        rows.iter().map(|row| (row.string("kind").unwrap(), row.opt_string("tag").unwrap())).collect()
    }

    #[tokio::test]
    async fn keeps_a_moderator_who_did_something_after_a_run_found_them_idle_and_before_it_ended_their_time() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        let root = BTreeMap::from([("root".to_owned(), dir.path().join("content").to_string_lossy().into_owned())]);
        let content = ContentStore::open("fs", &root, 0).unwrap();
        let (log, _) = Logger::collecting();
        let appointed = 1_000_000;
        for (id, name) in [(ALICE, "alice"), (BOB, "bob")] {
            testing::user(&db, id, name, false).await;
            db.execute(
                "INSERT INTO tag_moderators (tag, user_id, created_at, acted_at) VALUES (?, ?, ?, ?)",
                params!["cars", id, appointed, appointed],
            )
            .await
            .unwrap();
        }
        let now = appointed + 366 * DAY;
        let before = now - 365 * DAY;

        // What a run reads, longest idle first.
        let idle = idle_moderators(&db, before, 10).await.unwrap();
        assert_eq!(
            idle.iter().map(|m| (m.tag.as_str(), m.user_id.as_str())).collect::<Vec<_>>(),
            [("cars", ALICE), ("cars", BOB)]
        );
        assert_eq!(idle_moderators(&db, before, 1).await.unwrap().len(), 1);

        // Alice does something as its moderator, between the run reading her and ending her time.
        db.execute(
            "UPDATE tag_moderators SET acted_at = ? WHERE tag = ? AND user_id = ?",
            params![now, "cars", ALICE],
        )
        .await
        .unwrap();
        assert!(!retire_moderator(&db, &content, &log, now, &idle[0], before).await.unwrap());
        assert!(retire_moderator(&db, &content, &log, now, &idle[1], before).await.unwrap());
        // One who is gone already is not told twice.
        assert!(!retire_moderator(&db, &content, &log, now, &idle[1], before).await.unwrap());

        assert_eq!(moderators(&db).await, [ALICE]);
        assert_eq!(told(&db, ALICE).await, []);
        assert_eq!(told(&db, BOB).await, [("tag_moderator_lapsed".to_owned(), Some("cars".to_owned()))]);
    }

    #[tokio::test]
    async fn starts_counting_the_moderators_of_whom_nothing_is_known() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        testing::user(&db, ALICE, "alice", false).await;
        db.execute(
            "INSERT INTO tag_moderators (tag, user_id, created_at) VALUES (?, ?, ?)",
            params!["cars", ALICE, 1_i64],
        )
        .await
        .unwrap();
        assert_eq!(start_counting(&db, 5000).await.unwrap(), 1);
        assert_eq!(start_counting(&db, 9000).await.unwrap(), 0);
        let row = db.fetch_optional("SELECT acted_at FROM tag_moderators", &[]).await.unwrap().unwrap();
        assert_eq!(row.i64("acted_at").unwrap(), 5000);
    }
}
