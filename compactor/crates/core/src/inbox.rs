//! Notices, as this side leaves them in a user's inbox (the table `inbox`, see src/inbox.ts):
//! of a moderator's time on a hashtag that ended by itself, of a video that was refused, of an
//! entry for a post on another server that what the post now says has held for a moderator.
//! A notice is stored as its kind and what it is about, never as words: it is said in its
//! reader's language when the inbox is read.

use anyhow::Result;
use serde_json::json;
use uuid::Uuid;

use crate::content::{ContentMeta, ContentStore};
use crate::db::Db;
use crate::format::plain_text;
use crate::log::{self, Logger};
use crate::pending::effective_meta;
use crate::posts::PreviewKind;
use crate::text::{is_space, trim};

/// How much of a post a notice about it quotes, so its publisher can tell which it was once
/// it is gone.
const EXCERPT_CHARS: usize = 200;

/// A notice to leave: whose inbox it is for, what kind it is, and what it is about.
#[derive(Debug, Clone, Default)]
pub struct Notice<'a> {
    pub user_id: &'a str,
    pub kind: &'a str,
    /// Who did what the notice tells of: nobody is told of what they did themselves. Empty
    /// for what the server did by itself.
    pub by: &'a str,
    /// The post it is about, whose start it quotes.
    pub content_id: Option<&'a str>,
    /// The hashtag it is about.
    pub tag: Option<&'a str>,
    /// The text of the comment it is about, whose start it quotes in place of the post's.
    pub comment: Option<&'a str>,
}

/// The start of a text, as a notice quotes it. None for no text at all. A `formatted` text (a
/// post's, a caption, a comment's) is quoted as it reads, without its formatting.
pub fn excerpt(text: Option<&str>, formatted: bool) -> Option<String> {
    let text = text.filter(|text| !text.is_empty())?;
    let read = if formatted { plain_text(text, false) } else { text.to_owned() };
    // Each run of white space is one space.
    let mut spaced = String::with_capacity(read.len());
    let mut in_space = false;
    for c in read.chars() {
        if is_space(c) {
            if !in_space {
                spaced.push(' ');
            }
            in_space = true;
        } else {
            spaced.push(c);
            in_space = false;
        }
    }
    // By character, so the cut never splits one in two.
    let chars: Vec<char> = trim(&spaced).chars().collect();
    if chars.is_empty() {
        return None;
    }
    Some(if chars.len() > EXCERPT_CHARS {
        chars[..EXCERPT_CHARS - 1].iter().chain(&['…']).collect()
    } else {
        chars.into_iter().collect()
    })
}

/// The start of a post, as a notice about it quotes it: its text or caption, or a link's
/// URL. None for a file without a caption.
pub fn excerpt_of(meta: Option<&ContentMeta>) -> Option<String> {
    let preview = &meta?.preview;
    if preview.kind == PreviewKind::Link {
        excerpt(preview.url.as_deref(), false)
    } else {
        excerpt(preview.text.as_deref(), true)
    }
}

/// Leaves a notice in a user's inbox. It reports what was already done, so it never fails
/// what did it: a notice that can't be left is logged, and lost.
///
/// A notice about a post quotes its start, read from the post's meta file (as its newest
/// write made it), which is still there when the post has just been set for deletion: the
/// compactor removes it later. A notice about a comment quotes the comment's, which whoever
/// leaves the notice passes on: by then it may be gone.
pub async fn notify(db: &Db, content: &ContentStore, now: i64, notice: &Notice<'_>, log: &Logger) {
    if notice.by == notice.user_id {
        return;
    }
    let left: Result<()> = async {
        let body = match (notice.comment, notice.content_id) {
            (Some(comment), _) => excerpt(Some(comment), true),
            (None, Some(content_id)) if !content_id.is_empty() => excerpt_of(effective_meta(db, content, content_id).await?.as_ref()),
            _ => None,
        };
        db.execute(
            "INSERT INTO inbox (id, user_id, kind, sender_id, content_id, tag, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            crate::params![
                Uuid::new_v4().to_string(),
                notice.user_id,
                notice.kind,
                None::<&str>,
                notice.content_id,
                notice.tag,
                body,
                now,
                None::<i64>
            ],
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(err) = left {
        log.warn(
            json!({ "err": log::err(&err), "userId": notice.user_id, "kind": notice.kind, "contentId": notice.content_id, "tag": notice.tag }),
            "could not leave the notice in the inbox; the user is not told",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_start_of_a_text_as_it_reads() {
        assert_eq!(excerpt(Some("  **hello**\n\nthere  "), true).as_deref(), Some("hello there"));
        assert_eq!(excerpt(Some("**kept**"), false).as_deref(), Some("**kept**"));
        assert_eq!(excerpt(Some(" \n "), true), None);
        assert_eq!(excerpt(None, true), None);
        let long = excerpt(Some(&"é".repeat(201)), true).unwrap();
        assert_eq!(long.chars().count(), 200);
        assert!(long.ends_with('…'));
        assert_eq!(excerpt(Some(&"é".repeat(200)), true).unwrap().chars().count(), 200);
    }
}
