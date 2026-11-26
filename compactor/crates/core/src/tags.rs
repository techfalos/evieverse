//! Hashtags, as src/tags.ts has them: how what a person wrote is made the hashtag it names.

use anyhow::Result;

use crate::db::{Db, Queries, Value};
use crate::text::fold;

/// The longest a hashtag is, in characters.
pub const MAX_TAG_CHARS: usize = 64;

/// "#Central-Mumbai" -> "centralmumbai"; none if nothing usable is left. A hashtag is a single
/// word of lowercase letters, digits and underscores.
pub fn normalize_tag(input: &str) -> Option<String> {
    let tag: String = fold(input)
        .trim_start_matches('#')
        .chars()
        .filter(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
        .take(MAX_TAG_CHARS)
        .collect();
    (!tag.is_empty()).then_some(tag)
}

/// Notes that posts were just appended to these indexes: each is made if it isn't there, and
/// says when it was last appended to. In the order of their names, so that two writes that
/// touch the same ones take their rows in the same order.
pub async fn touch_tags(tx: &mut impl Queries, tags: &[String], now: i64) -> Result<()> {
    let mut sorted: Vec<&String> = tags.iter().collect();
    sorted.sort_unstable();
    sorted.dedup();
    let end = tx.dialect().upsert_end(&["name"], &["last_appended_at"]);
    for tag in sorted {
        tx.execute(
            &format!("INSERT INTO tags (name, created_at, last_appended_at) VALUES (?, ?, ?){end}"),
            crate::params![tag, now, now],
        )
        .await?;
    }
    Ok(())
}

/// Counts a write for the pairs of hashtags it carries, which is what related hashtags are
/// worked out from (`tag_pairs`): each of the hashtags the write `added` with each of the ones
/// it has (`tags`), itself among them, which counts the posts that carry it. One statement,
/// with its rows in the order of their names.
pub async fn count_tag_pairs(db: &Db, tags: &[String], added: &[String], now: i64) -> Result<()> {
    let mut pairs: Vec<(&str, &str)> = added
        .iter()
        .flat_map(|a| {
            tags.iter()
                .map(move |b| if a < b { (a.as_str(), b.as_str()) } else { (b.as_str(), a.as_str()) })
        })
        .collect();
    pairs.sort_unstable();
    pairs.dedup();
    if pairs.is_empty() {
        return Ok(());
    }
    let rows = vec!["(?, ?, 1, ?)"; pairs.len()].join(", ");
    let params: Vec<Value> = pairs.iter().flat_map(|(a, b)| [Value::from(*a), Value::from(*b), Value::from(now)]).collect();
    let end = match db.dialect() {
        crate::config::Dialect::Mysql => " ON DUPLICATE KEY UPDATE posts = tag_pairs.posts + 1, updated_at = VALUES(updated_at)",
        _ => " ON CONFLICT (tag_a, tag_b) DO UPDATE SET posts = tag_pairs.posts + 1, updated_at = excluded.updated_at",
    };
    db.execute(&format!("INSERT INTO tag_pairs (tag_a, tag_b, posts, updated_at) VALUES {rows}{end}"), &params)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn makes_a_hashtag_of_what_was_written() {
        assert_eq!(normalize_tag("#Central-Mumbai").as_deref(), Some("centralmumbai"));
        assert_eq!(normalize_tag("＃Café_1").as_deref(), Some("cafe_1"));
        assert_eq!(normalize_tag("##"), None);
        assert_eq!(normalize_tag(&"a".repeat(70)).map(|tag| tag.len()), Some(64));
    }
}
