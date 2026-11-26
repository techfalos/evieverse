//! Reposts, as src/reposts.ts has them. A repost gives a post that is there more hashtags. It
//! copies nothing: the post stays one piece of content, with one like count, credited to its
//! publisher. What it adds is rows of `reposts`, one for each index it puts the content in:
//! each hashtag it gave it, and the reposter's own index, which following feeds read.
//!
//! In those indexes the content is placed as a new post: at the time of the repost, counting
//! the likes since. That is the compactor's work, like everything in the index; and it is the
//! compactor that writes the hashtags a repost added into the content's meta file and summary,
//! which is when the content carries them.

use anyhow::Result;

use crate::db::{Queries, Row};
use crate::layout::index_author;

/// A place a repost gave content, as far as anything but the database's keys goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repost {
    /// The index the content is placed in: a hashtag, or the reposter's own (`@<userId>`).
    pub tag: String,
    /// Who reposted it; none once their account is gone.
    pub user_id: Option<String>,
    /// The likes the content had when it was reposted, which its place doesn't count.
    pub likes_before: i64,
    /// When it was reposted, which is where its place is.
    pub created_at: i64,
}

impl Repost {
    /// A place as a row of `reposts` has it.
    pub fn of(row: &Row) -> Result<Self> {
        Ok(Self {
            tag: row.string("tag")?,
            user_id: row.opt_string("user_id")?,
            likes_before: row.i64("likes_before")?,
            created_at: row.i64("created_at")?,
        })
    }
}

/// The places reposts gave a piece of content, oldest first, and those of one repost by tag.
pub async fn reposts_of(db: &mut impl Queries, content_id: &str) -> Result<Vec<Repost>> {
    db.fetch(
        "SELECT tag, user_id, likes_before, created_at FROM reposts WHERE content_id = ? ORDER BY created_at, tag",
        crate::params![content_id],
    )
    .await?
    .iter()
    .map(Repost::of)
    .collect()
}

/// The hashtags among the names of indexes: all of them but the reposters' own indexes.
pub fn reposted_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    tags.into_iter().filter(|tag| index_author(tag).is_none()).map(str::to_owned).collect()
}

/// The hashtags of reposts of the content that were removed, and that the compactor is yet to
/// take off it (`repost_removals`). Until it has, the content's meta file may still hold them,
/// and they are nobody's: not a repost's any more, and not its publisher's. One that another
/// repost gave the content since is among them too, and is that repost's.
pub async fn removed_repost_tags(db: &mut impl Queries, content_id: &str) -> Result<Vec<String>> {
    let rows = db
        .fetch("SELECT tag FROM repost_removals WHERE content_id = ?", crate::params![content_id])
        .await?;
    let tags = rows.iter().map(|row| row.str("tag")).collect::<Result<Vec<&str>>>()?;
    Ok(reposted_tags(tags))
}

/// When the content was reposted, once for each repost, oldest first: where its summary is
/// kept beside its own day (see `SummaryRef`).
pub fn repost_times(rows: &[Repost]) -> Vec<i64> {
    let mut times: Vec<i64> = rows.iter().map(|row| row.created_at).collect();
    times.sort_unstable();
    times.dedup();
    times
}
