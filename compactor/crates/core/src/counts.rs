//! How many posts each hashtag has, and how many the server has: `tags.post_count`, which
//! GET /tags gives with a hashtag and can list hashtags by, and the one row of
//! `server_counts`, which GET /rules gives. The compactor counts both as its runs write the
//! posts, and nothing else does.
//!
//! A post is counted while it has a row whose meta file a run has written, and it isn't kept
//! from readers (it waits in the moderation queue, or it is the server's entry for a post that
//! is gone from its own server): once for the server, and once for each hashtag its meta file
//! has. What it is counted for is on its row (`content.counted_tags`), and is written in the
//! transaction that changes the counts, so the counts are those of the rows, whatever stops a
//! run and wherever: a post counted again is found counted, and what is taken away is what was
//! added.

use std::collections::BTreeSet;

use anyhow::Result;

use crate::config::Dialect;
use crate::db::{Db, Queries};

/// The id of the one row of `server_counts`.
const SERVER: &str = "server";

/// What `content.counted_tags` holds of a post that is counted under `tags`: each once, in the
/// order of their names, with a space between each two. Empty for a post with no hashtag.
fn counted_as(tags: &[String]) -> String {
    let sorted: BTreeSet<&str> = tags.iter().map(String::as_str).filter(|tag| !tag.is_empty()).collect();
    sorted.into_iter().collect::<Vec<&str>>().join(" ")
}

/// The hashtags `content.counted_tags` names.
fn counted_under(counted: Option<&str>) -> BTreeSet<&str> {
    counted.into_iter().flat_map(|tags| tags.split(' ')).filter(|tag| !tag.is_empty()).collect()
}

/// Has a post counted for what it now is: under `tags`, the hashtags of its meta file, or with
/// none given, not at all, which is how a post that is kept from readers is counted. The
/// counts change by what differs from what the post was counted for, and its row says what it
/// is counted for from then on, in one transaction. A post that is counted for just this is
/// left as it is, and costs one read; one whose row is gone changes nothing.
///
/// Whatever writes a post's meta file calls this first, with the hashtags it is about to
/// write, as it does `index_content`: so it can be made again, and a run that stops between
/// the two finds nothing to change the second time.
///
/// The post's row is locked first, and then the rows of the hashtags in the order of their
/// names, as a request that publishes a post takes them (see `touch_tags`), and the server's
/// row last.
pub async fn count_post(db: &Db, content_id: &str, tags: Option<&[String]>, now: i64) -> Result<()> {
    const READ: &str = "SELECT counted_tags FROM content WHERE id = ?";
    let wanted = tags.map(counted_as);
    let Some(row) = db.fetch_optional(READ, crate::params![content_id]).await? else {
        return Ok(());
    };
    if row.opt_str("counted_tags")? == wanted.as_deref() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    let locked = tx
        .fetch_optional(&format!("{READ}{}", db.dialect().for_update()), crate::params![content_id])
        .await?;
    let Some(row) = locked else {
        return tx.rollback().await;
    };
    recount(&mut tx, content_id, row.opt_str("counted_tags")?, wanted.as_deref(), now).await?;
    tx.commit().await
}

/// Takes a post out of the counts, in the transaction that deletes its row, which is the
/// caller's and has the row locked: what the post was counted for is taken away as the row
/// goes, or not at all.
pub async fn uncount_post(tx: &mut impl Queries, content_id: &str) -> Result<()> {
    let row = tx
        .fetch_optional("SELECT counted_tags FROM content WHERE id = ?", crate::params![content_id])
        .await?;
    let Some(row) = row else { return Ok(()) };
    // Nothing is added, so no row of a hashtag is made, which is all the time is for.
    recount(tx, content_id, row.opt_str("counted_tags")?, None, 0).await
}

/// Changes the counts from what a post was counted for (`had`) to what it is to be counted
/// for (`wanted`), each as `content.counted_tags` has it, and writes that on its row.
///
/// A hashtag whose row isn't there gets one, as of `now`: nothing deletes those rows, and a
/// post is published under a hashtag only once a request has made its row, so this is for a
/// database something else wrote to. A count is never taken below 0.
async fn recount(tx: &mut impl Queries, content_id: &str, had: Option<&str>, wanted: Option<&str>, now: i64) -> Result<()> {
    if had == wanted {
        return Ok(());
    }
    let (before, after) = (counted_under(had), counted_under(wanted));
    let add = match tx.dialect() {
        Dialect::Mysql => " ON DUPLICATE KEY UPDATE post_count = tags.post_count + 1",
        _ => " ON CONFLICT (name) DO UPDATE SET post_count = tags.post_count + 1",
    };
    // In the order of their names, the ones added and the ones taken away as one list.
    for tag in before.symmetric_difference(&after) {
        if after.contains(tag) {
            tx.execute(
                &format!("INSERT INTO tags (name, created_at, last_appended_at, post_count) VALUES (?, ?, ?, 1){add}"),
                crate::params![*tag, now, now],
            )
            .await?;
        } else {
            tx.execute(
                "UPDATE tags SET post_count = post_count - 1 WHERE name = ? AND post_count > 0",
                crate::params![*tag],
            )
            .await?;
        }
    }
    match (had.is_some(), wanted.is_some()) {
        (false, true) => {
            let counted = tx
                .execute("UPDATE server_counts SET post_count = post_count + 1 WHERE id = ?", crate::params![SERVER])
                .await?;
            // The migration that made the table made the row.
            if counted == 0 {
                tx.execute("INSERT INTO server_counts (id, post_count) VALUES (?, 1)", crate::params![SERVER])
                    .await?;
            }
        }
        (true, false) => {
            tx.execute(
                "UPDATE server_counts SET post_count = post_count - 1 WHERE id = ? AND post_count > 0",
                crate::params![SERVER],
            )
            .await?;
        }
        _ => {}
    }
    tx.execute("UPDATE content SET counted_tags = ? WHERE id = ?", crate::params![wanted, content_id])
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing;

    /// How many posts the hashtag has, and none for a hashtag with no row.
    async fn posts_of(db: &Db, tag: &str) -> Option<i64> {
        let row = db
            .fetch_optional("SELECT post_count FROM tags WHERE name = ?", crate::params![tag])
            .await
            .unwrap();
        row.map(|row| row.i64("post_count").unwrap())
    }

    /// How many posts the server has.
    async fn posts(db: &Db) -> i64 {
        let row = db.fetch_optional("SELECT post_count FROM server_counts", &[]).await.unwrap();
        row.unwrap().i64("post_count").unwrap()
    }

    /// What the post's row says it is counted for.
    async fn counted(db: &Db, id: &str) -> Option<String> {
        let row = db
            .fetch_optional("SELECT counted_tags FROM content WHERE id = ?", crate::params![id])
            .await
            .unwrap();
        row.unwrap().opt_string("counted_tags").unwrap()
    }

    async fn post(db: &Db, id: &str) {
        db.execute(
            "INSERT INTO content (id, user_id, created_at) VALUES (?, ?, ?)",
            crate::params![id, "u1", 1_i64],
        )
        .await
        .unwrap();
    }

    fn tags(of: &[&str]) -> Vec<String> {
        of.iter().map(|tag| (*tag).to_owned()).collect()
    }

    #[tokio::test]
    async fn counts_a_post_for_the_server_and_for_each_of_its_hashtags_once() {
        let dir = tempfile::tempdir().unwrap();
        let db = testing::database(dir.path()).await;
        testing::user(&db, "u1", "alice", false).await;
        post(&db, "c1").await;
        post(&db, "c2").await;
        post(&db, "c3").await;
        assert_eq!((posts(&db).await, counted(&db, "c1").await), (0, None));

        // A hashtag a request made the row of, and one nothing did.
        db.execute(
            "INSERT INTO tags (name, created_at, last_appended_at) VALUES (?, ?, ?)",
            crate::params!["news", 5_i64, 5_i64],
        )
        .await
        .unwrap();
        count_post(&db, "c1", Some(&tags(&["news", "mumbai", "news"])), 10).await.unwrap();
        assert_eq!(counted(&db, "c1").await.as_deref(), Some("mumbai news"));
        assert_eq!(
            (posts_of(&db, "news").await, posts_of(&db, "mumbai").await, posts(&db).await),
            (Some(1), Some(1), 1)
        );
        let row = db
            .fetch_optional("SELECT last_appended_at FROM tags WHERE name = ?", crate::params!["news"])
            .await
            .unwrap();
        assert_eq!(row.unwrap().i64("last_appended_at").unwrap(), 5);

        // Again is nothing more, whatever order the hashtags come in.
        count_post(&db, "c1", Some(&tags(&["mumbai", "news"])), 11).await.unwrap();
        assert_eq!(
            (posts_of(&db, "news").await, posts_of(&db, "mumbai").await, posts(&db).await),
            (Some(1), Some(1), 1)
        );

        // A post with no hashtag is one of the server's, and no hashtag's.
        count_post(&db, "c2", Some(&[]), 12).await.unwrap();
        assert_eq!((counted(&db, "c2").await.as_deref(), posts(&db).await), (Some(""), 2));
        count_post(&db, "c3", Some(&tags(&["news"])), 13).await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(2), 3));

        // What a post lost is taken away, and what it gained is added.
        count_post(&db, "c1", Some(&tags(&["news", "weather"])), 14).await.unwrap();
        assert_eq!(counted(&db, "c1").await.as_deref(), Some("news weather"));
        assert_eq!(
            (
                posts_of(&db, "news").await,
                posts_of(&db, "mumbai").await,
                posts_of(&db, "weather").await,
                posts(&db).await
            ),
            (Some(2), Some(0), Some(1), 3)
        );

        // A post that is kept from readers isn't counted, and is again once it is back.
        count_post(&db, "c1", None, 15).await.unwrap();
        assert_eq!(counted(&db, "c1").await, None);
        assert_eq!(
            (posts_of(&db, "news").await, posts_of(&db, "weather").await, posts(&db).await),
            (Some(1), Some(0), 2)
        );
        count_post(&db, "c1", None, 16).await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(1), 2));
        count_post(&db, "c1", Some(&tags(&["news"])), 17).await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(2), 3));

        // A post that is deleted goes from the counts with its row, and one that isn't there changes nothing.
        let mut tx = db.begin().await.unwrap();
        uncount_post(&mut tx, "c3").await.unwrap();
        tx.execute("DELETE FROM content WHERE id = ?", crate::params!["c3"]).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(1), 2));
        count_post(&db, "c3", Some(&tags(&["news"])), 18).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        uncount_post(&mut tx, "c3").await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(1), 2));

        // A count that something else took to 0 stays there.
        db.execute("UPDATE tags SET post_count = 0 WHERE name = ?", crate::params!["news"])
            .await
            .unwrap();
        db.execute("UPDATE server_counts SET post_count = 0", &[]).await.unwrap();
        count_post(&db, "c1", None, 19).await.unwrap();
        assert_eq!((posts_of(&db, "news").await, posts(&db).await), (Some(0), 0));
    }
}
