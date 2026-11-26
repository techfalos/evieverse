//! The comments on posts, as src/storage/commentStore.ts keeps them, and the compactor's side
//! of that store.
//!
//! Each comment is one object in the content store, `comments/<postId>/<commentId>.json`: the
//! store is the only record of a published comment. A reply has a second object,
//! `comments/<postId>/<parentId>.<commentId>.reply`, which holds nothing: its name says which
//! comment the reply is to, so one list of the post's objects gives the whole tree. A like is
//! an object too, `comments/<postId>/likes/<commentId>/<userId>`. A comment that waits in the
//! moderation queue is under `held/` instead. The bytes of the image or video a comment came
//! with are one more object, `comments/<postId>/media/<commentId>`.
//!
//! What finds comments by who wrote them is an index of marks, beside the comments:
//! `authors/<userId>/comments/<part>/<commentId>.<postId>` for each comment a user wrote, and
//! `authors/<userId>/likes/<part>/<commentId>.<postId>` for each they liked. A mark is written
//! before what it is of, and deleted with it.
//!
//! Redis is a cache over all of it: `cmtidx:<postId>` is the post's index, a member for each
//! published comment; `cmt:<commentId>` a comment's JSON; `cmtl:<commentId>` the number of its
//! likes. All expire `hot_ms` after they were written.
//!
//! Only the compactor writes any of it, as it applies the writes requests committed: `put`,
//! `publish`, `hold`, `add_like`, `remove_like`, `remove` and `remove_all` are its own. The
//! pages and counts of likes that requests read (src/storage/commentStore.ts) have no part here.

use anyhow::{Context, Result};
use futures::StreamExt;
use futures::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json as fields};
use uuid::Uuid;

use crate::content::is_id;
use crate::hot::{HotStore, LexRange};
use crate::object::ObjectStore;
use crate::posts::Mention;
use crate::probe::Probes;

/// How many reads of the store one call has under way at once, for what Redis doesn't have.
const COLD_READS: usize = 32;
/// What an object holds whose name says it all: one byte, since not every backend takes an
/// empty object.
const MARK: &[u8] = b"1";
/// In a post's index once it holds every comment the store has. It sorts after every member,
/// which begin with a hex digit, a dash or a colon.
const COMPLETE: &str = "~";
/// What `cmtlm:<commentId>` begins with while the comment's likes are being made.
const MAKING: &str = "making:";
/// How many characters of a comment's id name the part of a user's index its mark is in. A
/// comment's id starts with the time it was sent at, so a part holds some three days.
const SPAN_CHARS: usize = 5;
/// The prefix the comments of every post are under, a prefix for each post that has any.
const COMMENTS_DIR: &str = "comments/";
/// In the store once every comment and like that was there before the index was kept has its mark.
const INDEXED_KEY: &str = "authors/indexed";
/// While those marks are being written: the id of the last post whose comments have theirs.
const INDEXING_KEY: &str = "authors/indexing";
/// How many posts have their marks written between two writes of INDEXING_KEY.
const INDEXING_STEP: usize = 100;

/// Why a comment is gone from among the post's published comments (see `placeholder`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Gone {
    /// For good.
    Deleted,
    /// Taken back to the moderation queue by an edit.
    Held,
}

/// What a comment says of the image or video it came with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentMedia {
    /// `image` or `video`.
    pub kind: String,
    pub mime_type: String,
    /// Of the bytes, as stored.
    pub size: i64,
    /// An image's alternative text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    /// Whatever else a later version says of it, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A comment on a post, as it is stored. See `Comment` in src/storage/commentStore.types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    /// A UUIDv7: the order of a post's comment ids is the order they were sent in.
    pub comment_id: String,
    /// The post it is on.
    pub content_id: String,
    /// The comment it replies to, which is on the same post.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// Who wrote it. Empty on a placeholder.
    pub user_id: String,
    /// What it says. Empty for one that is only its image or video.
    pub text: String,
    /// The users `text` mentions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Mention>>,
    /// Its author's declaration that it was created with AI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_generated: Option<bool>,
    /// The image or video it came with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<CommentMedia>,
    /// When it was sent. UTC epoch milliseconds.
    pub created_at: i64,
    /// When its author last edited it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<i64>,
    /// Set on what stands in a comment's place once the comment is gone from there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gone: Option<Gone>,
    /// Whatever else a comment written by a later version says, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// What stands in the place of a published comment that is gone from it: deleted, or taken
/// back to the moderation queue by an edit. It keeps the comment's place in the tree, so the
/// comments that reply to it stay where they are, and nothing of what the comment was.
pub fn placeholder(comment: &Comment, gone: Gone) -> Comment {
    Comment {
        comment_id: comment.comment_id.clone(),
        content_id: comment.content_id.clone(),
        parent_id: comment.parent_id.clone(),
        user_id: String::new(),
        text: String::new(),
        mentions: None,
        ai_generated: None,
        media: None,
        created_at: comment.created_at,
        edited_at: None,
        gone: Some(gone),
        extra: Map::new(),
    }
}

/// The prefix everything of a post's comments is under.
fn comment_dir(post_id: &str) -> String {
    format!("{COMMENTS_DIR}{post_id}/")
}
/// A published comment's object, which holds its JSON, or that of its placeholder.
fn comment_object_key(post_id: &str, comment_id: &str) -> String {
    format!("{}{comment_id}.json", comment_dir(post_id))
}
/// What says a published comment is a reply, and to which comment: an object whose name is
/// all there is to it.
fn reply_object_key(post_id: &str, parent_id: &str, comment_id: &str) -> String {
    format!("{}{parent_id}.{comment_id}.reply", comment_dir(post_id))
}
/// Where a comment is while it waits in the moderation queue.
fn held_comment_object_key(post_id: &str, comment_id: &str) -> String {
    format!("{}held/{comment_id}.json", comment_dir(post_id))
}
/// The prefix a comment's likes are under, an object for each user who liked it.
fn like_dir(post_id: &str, comment_id: &str) -> String {
    format!("{}likes/{comment_id}/", comment_dir(post_id))
}
/// A user's like of a comment: an object whose name is all there is to it.
fn like_object_key(post_id: &str, comment_id: &str, user_id: &str) -> String {
    format!("{}{user_id}", like_dir(post_id, comment_id))
}
/// The bytes of the image or video a comment came with. In one place whether the comment is
/// published or waits in the moderation queue.
pub fn comment_media_key(post_id: &str, comment_id: &str) -> String {
    format!("{}media/{comment_id}", comment_dir(post_id))
}
/// The prefix of a user's index of the comments they wrote.
fn authored_dir(user_id: &str) -> String {
    format!("authors/{user_id}/comments/")
}
/// The prefix of a user's index of the comments they liked.
fn liked_dir(user_id: &str) -> String {
    format!("authors/{user_id}/likes/")
}
/// A mark in a user's index (`dir`), which says the user wrote the comment, or liked it: the
/// comment's id and its post's, in the part of the index that the comment's id belongs to.
fn mark_key(dir: &str, post_id: &str, comment_id: &str) -> String {
    let span = comment_id.get(..SPAN_CHARS).unwrap_or(comment_id);
    format!("{dir}{span}/{comment_id}.{post_id}")
}

/// A post's published comments, each with the comment it replies to, in order, and COMPLETE
/// once it holds them all.
pub fn comment_index_key(post_id: &str) -> String {
    format!("cmtidx:{post_id}")
}
/// A comment's JSON, or its placeholder's; or nothing at all for one of which nothing is left.
pub fn comment_key(comment_id: &str) -> String {
    format!("cmt:{comment_id}")
}
/// How many likes a comment has.
pub fn comment_likes_key(comment_id: &str) -> String {
    format!("cmtl:{comment_id}")
}
/// Which making of a comment's likes was the last, and whether it is still under way.
pub fn comment_likes_made_key(comment_id: &str) -> String {
    format!("cmtlm:{comment_id}")
}

/// A comment in its post's index: the id of the comment it replies to (nothing, for a comment
/// on the post itself), a colon, and its own id.
fn member(parent_id: Option<&str>, comment_id: &str) -> String {
    format!("{}:{comment_id}", parent_id.unwrap_or_default())
}
/// The bounds of the members that reply to a comment, or without one, of those on the post
/// itself: ';' is what follows ':'.
fn under(parent_id: Option<&str>) -> LexRange {
    let parent = parent_id.unwrap_or_default();
    LexRange {
        after: Some(format!("{parent}:")),
        before: Some(format!("{parent};")),
    }
}
/// Whether a member is within the bounds, as `HotStore::lex_range` reads them.
fn within(m: &str, range: &LexRange) -> bool {
    range.after.as_deref().is_none_or(|after| m > after) && range.before.as_deref().is_none_or(|before| m < before)
}

/// The comment a stored object holds; none for bytes that are no comment's.
fn parse(blob: &[u8]) -> Option<Comment> {
    crate::json::from_slice(blob).ok()
}

/// The comment as it is stored: JSON.
fn json(comment: &Comment) -> Result<Vec<u8>> {
    serde_json::to_vec(comment).context("a comment could not be written as JSON")
}

/// The id a name that ends in `suffix` begins with, if that is all there is to the name.
fn id_before<'a>(name: &'a str, suffix: &str) -> Option<&'a str> {
    name.strip_suffix(suffix).filter(|id| is_id(id))
}

/// The two ids of a name made of two with `between` between them, in that order.
fn two_ids(name: &str, between: char) -> Option<(&str, &str)> {
    let (first, second) = (name.get(..36)?, name.get(37..)?);
    (name[36..].starts_with(between) && is_id(first) && is_id(second)).then_some((first, second))
}

/// What a making of a comment's likes is ended with (see `CommentStore::making_likes`).
pub struct MakingLikes {
    hot: HotStore,
    key: String,
    hot_ms: i64,
}

impl MakingLikes {
    /// Says that the likes are made: once their rows are settled.
    pub async fn done(self) -> Result<()> {
        self.hot.set(&self.key, Uuid::new_v4().to_string().as_bytes(), Some(self.hot_ms)).await
    }
}

/// What is to be left of a comment that is removed (see `CommentStore::remove`).
#[derive(Debug, Clone, Default)]
pub struct Removal {
    /// A placeholder is left where the comment was, or put there if nothing is, so its replies
    /// stay listed under it.
    pub keep_place: bool,
    /// The comment, for a caller that has read it, and for one that puts a placeholder where
    /// the comment no longer is.
    pub comment: Option<Comment>,
}

/// The comment store, as the compactor uses it.
#[derive(Clone)]
pub struct CommentStore {
    hot: HotStore,
    objects: ObjectStore,
    /// How long Redis keeps a post's index, each comment, and each number of likes.
    hot_ms: i64,
    /// What a test watches this store's calls with; nothing, in a process that serves.
    probes: Probes,
}

impl CommentStore {
    pub fn new(hot: HotStore, objects: ObjectStore, hot_ms: i64) -> Self {
        Self {
            hot,
            objects,
            hot_ms,
            probes: Probes::default(),
        }
    }

    /// This store, with its calls shown to a test's probe (see `crate::probe`).
    pub fn probed(mut self, probes: Probes) -> Self {
        self.probes = probes;
        self
    }

    async fn write(&self, key: &str, comment: &Comment) -> Result<()> {
        self.objects.write(key, json(comment)?, Some("application/json")).await
    }

    /// Writes a published comment's objects. A reply's second object goes first: a list of the
    /// post's objects made between the two then finds no comment yet, and never a reply it
    /// takes for a comment on the post itself.
    async fn store(&self, comment: &Comment) -> Result<()> {
        let (post_id, comment_id) = (&comment.content_id, &comment.comment_id);
        if let Some(parent_id) = comment.parent_id.as_deref().filter(|p| !p.is_empty()) {
            self.objects
                .write(&reply_object_key(post_id, parent_id, comment_id), MARK.to_vec(), None)
                .await?;
        }
        self.write(&comment_object_key(post_id, comment_id), comment).await
    }

    /// Deletes a published comment's objects, its likes, and the image or video it came with:
    /// the comment first, for the same reason `store` writes it last.
    async fn erase(&self, post_id: &str, comment_id: &str, parent_id: Option<&str>) -> Result<()> {
        self.objects.delete(&comment_object_key(post_id, comment_id)).await?;
        if let Some(parent_id) = parent_id.filter(|p| !p.is_empty()) {
            self.objects.delete(&reply_object_key(post_id, parent_id, comment_id)).await?;
        }
        self.strip(post_id, comment_id).await
    }

    /// Deletes what a comment has beside its own objects: its likes, and the image or video it
    /// came with.
    async fn strip(&self, post_id: &str, comment_id: &str) -> Result<()> {
        self.objects.remove_all(&like_dir(post_id, comment_id)).await?;
        self.objects.delete(&comment_media_key(post_id, comment_id)).await
    }

    /// Writes the mark that says who wrote a comment, in that user's index. Before the comment
    /// is written, wherever it is written, so no comment is ever there without its mark; a
    /// placeholder, which has no author, has none.
    async fn sign(&self, comment: &Comment) -> Result<()> {
        if comment.user_id.is_empty() {
            return Ok(());
        }
        let mark = mark_key(&authored_dir(&comment.user_id), &comment.content_id, &comment.comment_id);
        self.objects.write(&mark, MARK.to_vec(), None).await
    }

    /// Deletes the marks of a comment that is being removed: its author's, and those of the
    /// users who liked it, who are the names under its likes.
    async fn unsign(&self, post_id: &str, comment_id: &str, author: Option<&str>) -> Result<()> {
        if let Some(author) = author.filter(|a| !a.is_empty()) {
            self.objects.delete(&mark_key(&authored_dir(author), post_id, comment_id)).await?;
        }
        let likers = self.objects.names(&like_dir(post_id, comment_id), false).await?;
        let marks: Vec<String> = likers
            .iter()
            .filter(|name| is_id(name))
            .map(|user_id| mark_key(&liked_dir(user_id), post_id, comment_id))
            .collect();
        self.delete_all(marks).await
    }

    /// Deletes objects, several at a time, and fails with the first failure once all were tried.
    async fn delete_all(&self, keys: Vec<String>) -> Result<()> {
        let done: Vec<Result<()>> = stream::iter(keys)
            .map(|key| async move { self.objects.delete(&key).await })
            .buffer_unordered(COLD_READS)
            .collect()
            .await;
        done.into_iter().collect()
    }

    /// The marks that everything under a post's comments has, or is to have: one for each
    /// comment, published or held, in its author's index, and one for each like, in the index
    /// of the user whose it is. One list of all the post's objects names the likes and the
    /// comments; who wrote a comment is read from it. A placeholder has none.
    async fn marks_of(&self, post_id: &str) -> Result<Vec<String>> {
        let mut marks = vec![];
        let mut written = vec![];
        for name in self.objects.names(&comment_dir(post_id), true).await? {
            if let Some(id) = id_before(&name, ".json") {
                written.push(comment_object_key(post_id, id));
            } else if let Some(id) = name.strip_prefix("held/").and_then(|name| id_before(name, ".json")) {
                written.push(held_comment_object_key(post_id, id));
            } else if let Some((comment_id, user_id)) = name.strip_prefix("likes/").and_then(|name| two_ids(name, '/')) {
                marks.push(mark_key(&liked_dir(user_id), post_id, comment_id));
            }
        }
        let authored: Vec<Result<Option<String>>> = stream::iter(written)
            .map(|key| async move {
                let comment = self.objects.read(&key).await?.and_then(|blob| parse(&blob));
                Ok(comment
                    .filter(|comment| !comment.user_id.is_empty())
                    .map(|comment| mark_key(&authored_dir(&comment.user_id), post_id, &comment.comment_id)))
            })
            .buffer_unordered(COLD_READS)
            .collect()
            .await;
        for mark in authored {
            marks.extend(mark?);
        }
        Ok(marks)
    }

    /// Puts a stored comment in Redis: its JSON, then its place in its post's index.
    async fn index(&self, comment: &Comment) -> Result<()> {
        self.hot.set(&comment_key(&comment.comment_id), &json(comment)?, Some(self.hot_ms)).await?;
        let place = member(comment.parent_id.as_deref(), &comment.comment_id);
        self.hot.lex_add(&comment_index_key(&comment.content_id), &[place], self.hot_ms).await
    }

    /// Stores a new comment, published, or with `held`, to wait in the moderation queue. A
    /// published one that can't be put in its post's index is taken back, and the error given:
    /// a complete index that lacked it would hide it until the index was next built.
    pub async fn put(&self, comment: &Comment, held: bool) -> Result<()> {
        let shown = || fields!({ "comment": comment, "held": held });
        self.probes.call("comments.put", shown, self.put_now(comment, held)).await
    }

    async fn put_now(&self, comment: &Comment, held: bool) -> Result<()> {
        let (post_id, comment_id) = (&comment.content_id, &comment.comment_id);
        self.sign(comment).await?;
        if held {
            return self.write(&held_comment_object_key(post_id, comment_id), comment).await;
        }
        self.store(comment).await?;
        if let Err(err) = self.index(comment).await {
            let _ = self.erase(post_id, comment_id, comment.parent_id.as_deref()).await;
            let _ = self.hot.del(&[comment_key(comment_id)]).await;
            return Err(err);
        }
        // It has no likes yet, which saves its first readers the list that would say so.
        let _ = self.hot.set_if_absent(&comment_likes_key(comment_id), b"0", self.hot_ms).await;
        Ok(())
    }

    /// Publishes a comment that waits in the moderation queue, as it is given: it goes where
    /// the post's published comments are, over the placeholder an edit left there, and into
    /// the index. One that stops half way has published the comment or not, and has lost
    /// nothing: calling it again completes it.
    pub async fn publish(&self, comment: &Comment) -> Result<()> {
        let shown = || fields!({ "comment": comment });
        self.probes.call("comments.publish", shown, self.publish_now(comment)).await
    }

    async fn publish_now(&self, comment: &Comment) -> Result<()> {
        // It has its mark already, unless it is older than the index and still waits for its own.
        self.sign(comment).await?;
        self.store(comment).await?;
        self.index(comment).await?;
        self.objects.delete(&held_comment_object_key(&comment.content_id, &comment.comment_id)).await
    }

    /// Takes a published comment back to where comments wait in the moderation queue, as it is
    /// given: an edit of it that the server holds. A placeholder is left in its place, in the
    /// store and in Redis. Redis first, so that no reader finds the comment there once the
    /// store says it waits. If the store then can't be written, Redis is left nothing of the
    /// comment, to be read from the store again, where it still is.
    pub async fn hold(&self, comment: &Comment) -> Result<()> {
        let (post_id, comment_id) = (&comment.content_id, &comment.comment_id);
        let left = placeholder(comment, Gone::Held);
        self.sign(comment).await?;
        self.write(&held_comment_object_key(post_id, comment_id), comment).await?;
        self.hot.set(&comment_key(comment_id), &json(&left)?, Some(self.hot_ms)).await?;
        match self.write(&comment_object_key(post_id, comment_id), &left).await {
            Ok(()) => Ok(()),
            Err(err) => Err(self.forget(comment_id, err).await),
        }
    }

    /// Takes what Redis has of a comment out of it, after a write to the store that failed,
    /// and gives that failure back: Redis says nothing the store doesn't.
    async fn forget(&self, comment_id: &str, err: anyhow::Error) -> anyhow::Error {
        let _ = self.hot.del(&[comment_key(comment_id)]).await;
        err
    }

    /// A comment that waits in the moderation queue; none if the post has none by that id.
    pub async fn get_held(&self, post_id: &str, comment_id: &str) -> Result<Option<Comment>> {
        Ok(self
            .objects
            .read(&held_comment_object_key(post_id, comment_id))
            .await?
            .and_then(|blob| parse(&blob)))
    }

    /// A published comment of the post; none if it has none by that id, or only a placeholder.
    pub async fn get(&self, post_id: &str, comment_id: &str) -> Result<Option<Comment>> {
        Ok(self.find(post_id, comment_id).await?.filter(|found| found.gone.is_none()))
    }

    /// A published comment of the post, or the placeholder that stands in the place of one;
    /// none if it has neither by that id.
    pub async fn find(&self, post_id: &str, comment_id: &str) -> Result<Option<Comment>> {
        Ok(self.load(post_id, &[comment_id.to_owned()]).await?.pop().flatten())
    }

    /// The post's published comments by id, placeholders among them, in the order given: from
    /// Redis, and from the store those it doesn't have, which are then kept there. None for
    /// one that is gone.
    pub async fn load(&self, post_id: &str, ids: &[String]) -> Result<Vec<Option<Comment>>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let keys: Vec<String> = ids.iter().map(|id| comment_key(id)).collect();
        let cached = self.hot.mget(&keys).await?;
        let loaded: Vec<Result<Option<Comment>>> = stream::iter(ids.iter().zip(cached))
            .map(|(id, cached)| async move {
                let blob = match cached {
                    Some(blob) => blob,
                    None => {
                        let Some(blob) = self.objects.read(&comment_object_key(post_id, id)).await? else {
                            return Ok(None);
                        };
                        // Only where Redis has nothing, so a comment read just before it was deleted never replaces what its deletion left there.
                        let _ = self.hot.set_if_absent(&comment_key(id), &blob, self.hot_ms).await;
                        blob
                    }
                };
                // Gone: what `remove` left in Redis. And Redis keeps a comment by its id alone: one of another post isn't this post's.
                Ok(parse(&blob).filter(|comment| !blob.is_empty() && comment.content_id == post_id))
            })
            .buffered(COLD_READS)
            .collect()
            .await;
        loaded.into_iter().collect()
    }

    /// The members of the post's index as the store has them, in order: one list of its
    /// objects. A comment is a reply if an object says so, and a comment on the post itself
    /// otherwise. What says a comment is a reply, with no such comment, says nothing. A
    /// placeholder is listed as the comment it stands for.
    async fn list(&self, post_id: &str) -> Result<Vec<String>> {
        let mut ids = std::collections::BTreeSet::new();
        let mut replies = vec![];
        for name in self.objects.names(&comment_dir(post_id), false).await? {
            if let Some(id) = id_before(&name, ".json") {
                ids.insert(id.to_owned());
            } else if let Some((parent_id, comment_id)) = name.strip_suffix(".reply").and_then(|name| two_ids(name, '.')) {
                replies.push((parent_id.to_owned(), comment_id.to_owned()));
            }
        }
        let mut members = vec![];
        for (parent_id, comment_id) in replies {
            // Taken out as it is listed, so what is left are the comments on the post itself.
            if ids.remove(&comment_id) {
                members.push(member(Some(&parent_id), &comment_id));
            }
        }
        members.extend(ids.iter().map(|id| member(None, id)));
        members.sort();
        Ok(members)
    }

    /// Builds the post's index from the store, and returns the members it listed, in order.
    /// The members are added first and COMPLETE last, so an index is never called complete
    /// before it is. Should Redis drop the index while it is being filled, it is left out
    /// rather than called complete with part of the members.
    async fn rebuild(&self, post_id: &str) -> Result<Vec<String>> {
        let key = comment_index_key(post_id);
        let members = self.list(post_id).await?;
        self.hot.lex_add(&key, &members, self.hot_ms).await?;
        self.hot.lex_add(&key, &[COMPLETE.to_owned()], self.hot_ms).await?;
        let before = LexRange {
            after: None,
            before: Some(COMPLETE.to_owned()),
        };
        if usize::try_from(self.hot.lex_count(&key, &before).await?).unwrap_or(0) < members.len() {
            self.hot.del(&[key]).await?;
        }
        Ok(members)
    }

    /// How many of the index's members are within each of the bounds.
    async fn counts(&self, post_id: &str, ranges: &[LexRange]) -> Result<Vec<i64>> {
        let key = comment_index_key(post_id);
        if self.hot.lex_has(&key, COMPLETE).await? {
            let mut counted = Vec::with_capacity(ranges.len());
            for range in ranges {
                counted.push(self.hot.lex_count(&key, range).await?);
            }
            return Ok(counted);
        }
        let members = self.rebuild(post_id).await?;
        Ok(ranges
            .iter()
            .map(|range| i64::try_from(members.iter().filter(|m| within(m, range)).count()).unwrap_or(i64::MAX))
            .collect())
    }

    /// How many published comments the post has, replies and all, placeholders among them; or
    /// with `parent_id`, how many reply to that comment.
    pub async fn count(&self, post_id: &str, parent_id: Option<&str>) -> Result<i64> {
        let range = match parent_id {
            Some(parent_id) => under(Some(parent_id)),
            None => LexRange {
                after: None,
                before: Some(COMPLETE.to_owned()),
            },
        };
        Ok(self.counts(post_id, &[range]).await?.pop().unwrap_or(0))
    }

    /// How many comments reply to each of these, in the order given: to it, not to its replies.
    pub async fn reply_counts(&self, post_id: &str, comment_ids: &[String]) -> Result<Vec<i64>> {
        if comment_ids.is_empty() {
            return Ok(vec![]);
        }
        let ranges: Vec<LexRange> = comment_ids.iter().map(|id| under(Some(id))).collect();
        self.counts(post_id, &ranges).await
    }

    /// Whether the store has the user's like of the comment: one that was applied, and not
    /// taken back since.
    pub async fn liked(&self, post_id: &str, comment_id: &str, user_id: &str) -> Result<bool> {
        self.objects.exists(&like_object_key(post_id, comment_id, user_id)).await
    }

    /// Makes a user's like of a published comment, which is made once: one that is there
    /// already is left as it is. A number of likes that Redis has is then one more; a like
    /// that is found made may be one this made before and stopped short of counting, so the
    /// number is then left to be counted again. Its mark in the user's index goes first, and
    /// is written whether or not the like is there.
    pub async fn add_like(&self, post_id: &str, comment_id: &str, user_id: &str) -> Result<()> {
        let shown = || fields!({ "postId": post_id, "commentId": comment_id, "userId": user_id });
        self.probes
            .call("comments.addLike", shown, self.add_like_now(post_id, comment_id, user_id))
            .await
    }

    async fn add_like_now(&self, post_id: &str, comment_id: &str, user_id: &str) -> Result<()> {
        let key = like_object_key(post_id, comment_id, user_id);
        self.objects
            .write(&mark_key(&liked_dir(user_id), post_id, comment_id), MARK.to_vec(), None)
            .await?;
        if self.objects.exists(&key).await? {
            return self.hot.del(&[comment_likes_key(comment_id)]).await;
        }
        self.objects.write(&key, MARK.to_vec(), None).await?;
        self.hot.bump(&comment_likes_key(comment_id), 1).await?;
        Ok(())
    }

    /// Takes a user's like of a comment back: the like's object goes, and then its mark in the
    /// user's index, which is no longer of anything. One that isn't there is left that way. A
    /// number of likes that Redis has is then one less; a like that is found gone leaves the
    /// number to be counted again, as `add_like` leaves it.
    pub async fn remove_like(&self, post_id: &str, comment_id: &str, user_id: &str) -> Result<()> {
        let shown = || fields!({ "postId": post_id, "commentId": comment_id, "userId": user_id });
        self.probes
            .call("comments.removeLike", shown, self.remove_like_now(post_id, comment_id, user_id))
            .await
    }

    async fn remove_like_now(&self, post_id: &str, comment_id: &str, user_id: &str) -> Result<()> {
        let key = like_object_key(post_id, comment_id, user_id);
        let there = self.objects.exists(&key).await?;
        // The like before its mark: what is there always has its mark, and a mark may name what isn't.
        if there {
            self.objects.delete(&key).await?;
        }
        self.objects.delete(&mark_key(&liked_dir(user_id), post_id, comment_id)).await?;
        if there {
            self.hot.bump(&comment_likes_key(comment_id), -1).await?;
        } else {
            self.hot.del(&[comment_likes_key(comment_id)]).await?;
        }
        Ok(())
    }

    /// Says that likes of the comment are being made, or taken back, until what it returns is
    /// ended: once the rows of those likes are settled. Between the two, a like that was made
    /// is in the store and is still a row that waits, and a request that adds the one to the
    /// other counts it twice; so such a request reads what this writes before it counts and
    /// after.
    pub async fn making_likes(&self, comment_id: &str) -> Result<MakingLikes> {
        let key = comment_likes_made_key(comment_id);
        self.hot.set(&key, format!("{MAKING}{}", Uuid::new_v4()).as_bytes(), Some(self.hot_ms)).await?;
        Ok(MakingLikes {
            hot: self.hot.clone(),
            key,
            hot_ms: self.hot_ms,
        })
    }

    /// Removes a comment, published or held, for good, with its likes and the image or video
    /// it came with, and nothing else: the comments that reply to it stay as they are. With
    /// `keep_place`, a placeholder is left where the comment was, or put there if nothing is,
    /// so its replies stay listed under it; without, nothing of it is left.
    ///
    /// Redis goes first, before the store: it is left the placeholder, or an empty value, in
    /// place of the comment's JSON. An empty value says the comment is gone to whoever still
    /// finds it in the index. If the store then can't be written, Redis is left nothing of the
    /// comment, to be read from the store again: a removal that failed can be made again.
    pub async fn remove(&self, post_id: &str, comment_id: &str, removal: Removal) -> Result<()> {
        let shown = || fields!({ "postId": post_id, "commentId": comment_id });
        self.probes.call("comments.remove", shown, self.remove_now(post_id, comment_id, removal)).await
    }

    async fn remove_now(&self, post_id: &str, comment_id: &str, removal: Removal) -> Result<()> {
        let was = match removal.comment {
            Some(comment) => Some(comment),
            None => match self.find(post_id, comment_id).await? {
                Some(found) => Some(found),
                None => self.get_held(post_id, comment_id).await?,
            },
        };
        let left = was.as_ref().filter(|_| removal.keep_place).map(|was| placeholder(was, Gone::Deleted));
        let key = comment_index_key(post_id);
        // Its marks first, while its likes are there to say whose they are. Who wrote a comment that an edit took back to the
        // queue is said where it waits, not by the placeholder in its place. A placeholder of a deleted comment has no marks left.
        let gone = was.as_ref().and_then(|was| was.gone);
        if gone != Some(Gone::Deleted) {
            let author = if gone == Some(Gone::Held) {
                self.get_held(post_id, comment_id).await?.map(|held| held.user_id)
            } else {
                was.as_ref().map(|was| was.user_id.clone())
            };
            self.unsign(post_id, comment_id, author.as_deref()).await?;
        }
        let parent_id = was.as_ref().and_then(|was| was.parent_id.as_deref());
        if let Some(left) = &left {
            self.hot.set(&comment_key(comment_id), &json(left)?, Some(self.hot_ms)).await?;
            if let Err(err) = self.store(left).await {
                return Err(self.forget(comment_id, err).await);
            }
            self.hot.lex_add(&key, &[member(left.parent_id.as_deref(), comment_id)], self.hot_ms).await?;
            self.strip(post_id, comment_id).await?;
        } else {
            self.hot.set(&comment_key(comment_id), b"", Some(self.hot_ms)).await?;
            if let Err(err) = self.erase(post_id, comment_id, parent_id).await {
                return Err(self.forget(comment_id, err).await);
            }
        }
        self.objects.delete(&held_comment_object_key(post_id, comment_id)).await?;
        if left.is_none() {
            self.hot.lex_rem(&key, &[member(parent_id, comment_id)]).await?;
        }
        self.hot.del(&[comment_likes_key(comment_id)]).await
    }

    /// Removes every comment of a post, published and held, their likes, their images and
    /// videos, and its index: the post is being deleted. What Redis has of each expires. Their
    /// marks in users' indexes go first, while the comments and likes are there to say whose
    /// they are, so a removal that stops is made again from what is left.
    pub async fn remove_all(&self, post_id: &str) -> Result<()> {
        let marks = self.marks_of(post_id).await?;
        self.delete_all(marks).await?;
        self.objects.remove_all(&comment_dir(post_id)).await?;
        self.hot.del(&[comment_index_key(post_id)]).await
    }

    /// Whether users' indexes hold everything: every comment and like in the store has its mark.
    pub async fn indexed(&self) -> Result<bool> {
        self.objects.exists(INDEXED_KEY).await
    }

    /// Writes the marks of the comments and likes that were in the store before the index was
    /// kept, a post at a time, in the order of the posts' ids, and says in the store that it
    /// has, once it has been through them all: from then on `indexed` is true, and this does
    /// nothing. Where it has got to is written every INDEXING_STEP posts, and when `stopped`
    /// says to stop, so a process that takes it up again goes on from there. Returns whether
    /// it is done.
    pub async fn index_authors(&self, stopped: &(dyn Fn() -> bool + Sync)) -> Result<bool> {
        if self.indexed().await? {
            return Ok(true);
        }
        let last = self
            .objects
            .read(INDEXING_KEY)
            .await?
            .map(|blob| String::from_utf8_lossy(&blob).into_owned())
            .unwrap_or_default();
        let mut posts: Vec<String> = self
            .objects
            .names(COMMENTS_DIR, false)
            .await?
            .iter()
            .filter_map(|name| name.strip_suffix('/').filter(|id| is_id(id)))
            .filter(|post_id| *post_id > last.as_str())
            .map(str::to_owned)
            .collect();
        posts.sort();
        for (i, post_id) in posts.iter().enumerate() {
            if stopped() {
                if i > 0 {
                    self.objects.write(INDEXING_KEY, posts[i - 1].clone().into_bytes(), None).await?;
                }
                return Ok(false);
            }
            let marks = self.marks_of(post_id).await?;
            let written: Vec<Result<()>> = stream::iter(marks)
                .map(|mark| async move { self.objects.write(&mark, MARK.to_vec(), None).await })
                .buffer_unordered(COLD_READS)
                .collect()
                .await;
            written.into_iter().collect::<Result<()>>()?;
            if (i + 1) % INDEXING_STEP == 0 {
                self.objects.write(INDEXING_KEY, post_id.clone().into_bytes(), None).await?;
            }
        }
        self.objects.write(INDEXED_KEY, MARK.to_vec(), None).await?;
        self.objects.delete(INDEXING_KEY).await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0198c0de-0000-7000-8000-00000000000a";
    const B: &str = "0198c0de-0000-7000-8000-00000000000b";

    #[test]
    fn names_a_comments_objects_as_the_api_reads_them() {
        assert_eq!(comment_object_key("p", A), format!("comments/p/{A}.json"));
        assert_eq!(reply_object_key("p", A, B), format!("comments/p/{A}.{B}.reply"));
        assert_eq!(held_comment_object_key("p", A), format!("comments/p/held/{A}.json"));
        assert_eq!(like_object_key("p", A, "u"), format!("comments/p/likes/{A}/u"));
        assert_eq!(comment_media_key("p", A), format!("comments/p/media/{A}"));
        assert_eq!(mark_key(&authored_dir("u"), "p", A), format!("authors/u/comments/0198c/{A}.p"));
        assert_eq!(mark_key(&liked_dir("u"), "p", A), format!("authors/u/likes/0198c/{A}.p"));
    }

    #[test]
    fn reads_the_ids_out_of_the_names_of_objects() {
        assert_eq!(id_before(&format!("{A}.json"), ".json"), Some(A));
        assert_eq!(id_before("held.json", ".json"), None);
        assert_eq!(two_ids(&format!("{A}.{B}"), '.'), Some((A, B)));
        assert_eq!(two_ids(&format!("{A}/{B}"), '/'), Some((A, B)));
        assert_eq!(two_ids(&format!("{A}.{B}x"), '.'), None);
        assert_eq!(two_ids(A, '.'), None);
    }

    #[test]
    fn orders_replies_under_the_comment_they_reply_to() {
        assert_eq!(member(None, A), format!(":{A}"));
        assert_eq!(member(Some(A), B), format!("{A}:{B}"));
        let replies = under(Some(A));
        assert!(within(&member(Some(A), B), &replies));
        assert!(!within(&member(None, A), &replies));
        assert!(!within(&member(Some(B), A), &replies));
        assert!(within(&member(None, A), &under(None)));
        assert!(!within(COMPLETE, &under(None)));
    }

    #[test]
    fn leaves_nothing_of_a_comment_in_its_placeholder() {
        let comment: Comment = serde_json::from_str(&format!(
            r#"{{"commentId":"{B}","contentId":"p","parentId":"{A}","userId":"u","text":"hi","createdAt":5,"editedAt":9}}"#
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&placeholder(&comment, Gone::Deleted)).unwrap(),
            format!(r#"{{"commentId":"{B}","contentId":"p","parentId":"{A}","userId":"","text":"","createdAt":5,"gone":"deleted"}}"#)
        );
    }
}
