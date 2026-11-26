//! Uploaded bytes and the meta file of each piece of content, the bytes of the images and
//! videos that comments come with, the images of ads and users' avatars and splash images. The same keys as
//! src/storage/contentStore.ts, and the compactor's side of that store: only the compactor
//! writes or deletes a post's bytes and meta file, and a comment's image or video. What a
//! request writes is a staged file, which the compactor makes the post's or the comment's.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use anyhow::{Context, Result, bail};
use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::comments::comment_media_key;
use crate::object::{ObjectStat, ObjectStore};
use crate::posts::{Mention, Origin, Preview};
use crate::probe::Probes;

/// One image of an image post of several, as its meta file describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredImage {
    /// Which image it is, read from its bytes.
    pub mime_type: String,
    /// Of its bytes, as stored.
    pub size: i64,
    /// The SHA-256 of its bytes as stored, in hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

/// What describes a piece of content's bytes, kept in a file beside them rather than in the
/// database: an update overwrites both. See `ContentMeta` in src/storage/contentStore.types.ts
/// for what each field says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMeta {
    pub content_id: String,
    pub mime_type: String,
    /// Of the bytes, as stored.
    pub size: i64,
    /// The SHA-256 of an image's, video's or audio's bytes, in hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// On an image post of more than one image: every image, in the order the post has them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<StoredImage>>,
    pub ai_generated: bool,
    /// Whether the post takes comments. Absent: it doesn't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<bool>,
    /// The post's title: one line of plain text. Absent on a post that has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// As written; read it with `preview_of`, which links a file to where its bytes are read.
    pub preview: Preview,
    /// The whole text of a text post, or an image's, video's or audio's caption.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The users `text` mentions, in the order it first names them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mentions: Option<Vec<Mention>>,
    /// The content's hashtags: the ones its publisher gave it and, once the compactor has
    /// written them in, the ones reposts gave it.
    pub tags: Vec<String>,
    /// When the content was last written. UTC epoch milliseconds.
    pub updated_at: i64,
    /// On a repost of a post that is on another server: the original.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    /// With `origin`: when the original's server signed the attestation this summary is from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_attested_at: Option<i64>,
    /// Whatever else a meta file written by a later version says, which is kept as it is.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Whether `id` is written as a UUID is: 36 characters, each a lowercase hex digit or a dash.
pub(crate) fn is_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// Whether `file` is the name of a file of a processed video: its poster, the master playlist
/// of its stream, and for each rendition, named by its height, a playlist and numbered
/// segments (`poster.jpg`, `master.m3u8`, `720p.m3u8`, `720p_00001.ts`).
pub fn is_media_file(file: &str) -> bool {
    if file == "poster.jpg" || file == "master.m3u8" {
        return true;
    }
    let digits = file.bytes().take_while(u8::is_ascii_digit).count();
    if !(3..=4).contains(&digits) {
        return false;
    }
    match &file[digits..] {
        "p.m3u8" => true,
        rest => rest
            .strip_prefix("p_")
            .and_then(|rest| rest.strip_suffix(".ts"))
            .is_some_and(|number| number.len() == 5 && number.bytes().all(|b| b.is_ascii_digit())),
    }
}

/// Where a post's bytes are kept: an image's, video's or audio's file, a text post's text, or
/// a link's URL.
fn content_key(content_id: &str) -> String {
    format!("content/{content_id}")
}

/// Where an image of an image post is kept, by its place among the post's images, counted
/// from 1. The first is the post's bytes; each one after it is a file of its own beside them.
fn image_key(content_id: &str, image: i64) -> String {
    if image == 1 {
        content_key(content_id)
    } else {
        format!("{}.{image}", content_key(content_id))
    }
}

/// Where a post's meta file is kept: beside its bytes, as JSON.
fn meta_key(content_id: &str) -> String {
    format!("content/{content_id}.meta.json")
}

/// Where the image of an image ad is kept: apart from posts, as an ad is no post.
fn ad_image_key(ad_id: &str) -> String {
    format!("ads/{ad_id}")
}

/// Where a user's avatars are kept: apart from posts, and all under the user's id, so that
/// whatever is left of them goes with the account in one deletion.
fn avatar_prefix(user_id: &str) -> String {
    format!("avatars/{user_id}/")
}

/// Where a user's splash images are kept: apart from posts and from avatars, and all under
/// the user's id, so that whatever is left of them goes with the account in one deletion.
fn splash_prefix(user_id: &str) -> String {
    format!("splashes/{user_id}/")
}

/// Where what the server made of a post's videos is kept: a folder for each version of its
/// video, all of them under the post's id, so that they go with the post in one deletion.
fn media_prefix(content_id: &str) -> String {
    format!("media/{content_id}/")
}

/// Where the file a write came with waits for the compactor, under an id of the write's own.
pub fn staged_key(write_id: &str) -> String {
    format!("staged/{write_id}")
}

/// A staged file's key, as a row of `pending_writes` names it: fails for anything that isn't
/// one. A key that a row names is held to it before anything is read, copied or deleted by it.
fn staged_object(key: &str) -> Result<&str> {
    if key.strip_prefix("staged/").is_some_and(is_id) {
        Ok(key)
    } else {
        bail!("\"{key}\" is not a staged file")
    }
}

/// Whose bytes a file in the store is. They are written, read and deleted the same way; only
/// where they are kept differs.
#[derive(Debug, Clone, Copy)]
pub enum BytesOwner<'a> {
    /// A post's, named by the post's id.
    Post(&'a str),
    /// Those of one image of an image post, named by the post and the image's place among its
    /// images, counted from 1.
    Image { content_id: &'a str, image: i64 },
    /// Those of a file of a post's processed video, named by the post, the version of the
    /// video and the file.
    Video { content_id: &'a str, video: &'a str, file: &'a str },
    /// Those of the image or video a comment came with, named by the comment and its post.
    Comment { post_id: &'a str, comment_id: &'a str },
    /// The image of an ad.
    Ad(&'a str),
    /// A user's avatar, named by the user and the avatar's id.
    Avatar { user_id: &'a str, avatar: &'a str },
    /// A user's splash image, named by the user and the splash image's id.
    Splash { user_id: &'a str, splash: &'a str },
    /// A staged file's, named by its key.
    Staged(&'a str),
}

impl BytesOwner<'_> {
    /// Where the bytes are kept. Fails for a name that is none of a video's files, an id that
    /// isn't written as a UUID is, or a key that is no staged file's.
    pub fn key(&self) -> Result<String> {
        Ok(match *self {
            Self::Post(content_id) => content_key(content_id),
            Self::Image { content_id, image } => image_key(content_id, image),
            Self::Video { content_id, video, file } => {
                if !is_id(video) || !is_media_file(file) {
                    bail!("\"{video}/{file}\" is not a file of a video");
                }
                format!("{}{video}/{file}", media_prefix(content_id))
            }
            Self::Comment { post_id, comment_id } => comment_media_key(post_id, comment_id),
            Self::Ad(ad_id) => ad_image_key(ad_id),
            Self::Avatar { user_id, avatar } => {
                if !is_id(avatar) {
                    bail!("\"{avatar}\" is not the id of an avatar");
                }
                format!("{}{avatar}", avatar_prefix(user_id))
            }
            Self::Splash { user_id, splash } => {
                if !is_id(splash) {
                    bail!("\"{splash}\" is not the id of a splash image");
                }
                format!("{}{splash}", splash_prefix(user_id))
            }
            Self::Staged(key) => staged_object(key)?.to_owned(),
        })
    }
}

/// Whether a store with these settings gives links to read its files with through a signer of
/// the API's own, having no key to sign with and running where it needs none (see
/// src/storage/linkSigner.ts): `gcs` as the service account the process runs as, `azblob` as
/// its managed identity.
fn has_link_signer(scheme: &str, options: &BTreeMap<String, String>) -> bool {
    let set = |name: &str| options.get(name).is_some_and(|value| !value.is_empty());
    let env = |name: &str| std::env::var(name).is_ok_and(|value| !value.is_empty());
    match scheme {
        "gcs" => !set("credential") && !set("credential_path") && !env("GOOGLE_APPLICATION_CREDENTIALS"),
        "azblob" => !set("account_key") && !set("sas_token") && env("IDENTITY_ENDPOINT") && env("IDENTITY_HEADER"),
        _ => false,
    }
}

/// The content store, as the compactor and its workers use it.
#[derive(Clone)]
pub struct ContentStore {
    objects: ObjectStore,
    /// For how long a link to read a file with may be in use after it was given, in ms; 0
    /// where the store gives none. Shared by the copies of the store.
    link_ms: Arc<AtomicI64>,
    /// What a test watches this store's calls with; nothing, in a process that serves.
    probes: Probes,
}

impl ContentStore {
    /// The store the settings name (`storage.content` of the configuration).
    pub fn open(scheme: &str, options: &BTreeMap<String, String>, signed_url_seconds: i64) -> Result<Self> {
        let objects = ObjectStore::open(scheme, options)?;
        // Whether it can sign at all, not whether it last could: a link given before a signature failed is still in use.
        let signs = has_link_signer(scheme, options) || objects.presigns_reads();
        Ok(Self {
            objects,
            link_ms: Arc::new(AtomicI64::new(if signs { signed_url_seconds * 1000 } else { 0 })),
            probes: Probes::default(),
        })
    }

    /// This store, with its calls shown to a test's probe (see `crate::probe`).
    pub fn probed(mut self, probes: Probes) -> Self {
        self.probes = probes;
        self
    }

    /// Has the store say its links last this long, whatever it is: a test's way to a store
    /// that signs links, which no test has.
    pub fn set_link_ms(&self, ms: i64) {
        self.link_ms.store(ms, Ordering::Relaxed);
    }

    /// The object store the content is in.
    pub fn objects(&self) -> &ObjectStore {
        &self.objects
    }

    /// For how long a link to read a file with may be in use after it was given, in
    /// milliseconds: 0 where the store gives none, and files are read through the app. What
    /// the compactor keeps an applied staged file for.
    pub fn link_ms(&self) -> i64 {
        self.link_ms.load(Ordering::Relaxed)
    }

    /// Writes a local file as `of`'s bytes, over the ones it had.
    pub async fn put_file(&self, of: BytesOwner<'_>, local: &Path, mime_type: &str) -> Result<()> {
        let key = of.key()?;
        self.probes
            .call("content.putFile", || json!({ "key": key }), self.objects.write_file(&key, local, mime_type))
            .await
    }

    /// Writes bytes that are in memory as `of`'s, over the ones it had: a text post's text, a
    /// link's URL.
    pub async fn put_bytes(&self, of: BytesOwner<'_>, bytes: Vec<u8>, mime_type: &str) -> Result<()> {
        let key = of.key()?;
        self.probes
            .call("content.putBytes", || json!({ "key": key }), self.objects.write(&key, bytes, Some(mime_type)))
            .await
    }

    /// Stages a local file for the write `write_id`, and returns the staged file's key.
    pub async fn stage_file(&self, write_id: &str, local: &Path, mime_type: &str) -> Result<String> {
        let key = staged_key(write_id);
        self.put_file(BytesOwner::Staged(&key), local, mime_type).await?;
        Ok(key)
    }

    /// Makes a staged file `of`'s bytes, over the ones it had: copied within the backend where
    /// it can, else through this process. The staged file stays, so that this can be done
    /// again; `remove_staged` deletes it. Fails, with an error `is_not_found` knows, if there
    /// is no such file.
    pub async fn adopt(&self, staged: &str, of: BytesOwner<'_>, mime_type: &str) -> Result<()> {
        let from = staged_object(staged)?;
        let to = of.key()?;
        if self.objects.copies() && self.objects.copy(from, &to).await.is_ok() {
            return Ok(());
        }
        self.objects.pipe(from, &to, mime_type).await
    }

    /// Deletes a staged file. One that isn't there is no error.
    pub async fn remove_staged(&self, staged: &str) -> Result<()> {
        let key = staged_object(staged)?;
        self.probes
            .call("content.removeStaged", || json!({ "key": key }), self.objects.delete(key))
            .await
    }

    /// Writes a post's meta file, over the one it had.
    pub async fn put_meta(&self, meta: &ContentMeta) -> Result<()> {
        let json = serde_json::to_vec(meta).context("a meta file could not be written as JSON")?;
        let key = meta_key(&meta.content_id);
        self.probes
            .call(
                "content.putMeta",
                || json!({ "meta": meta }),
                self.objects.write(&key, json, Some("application/json")),
            )
            .await
    }

    /// A post's meta file; none for a post that has none.
    pub async fn get_meta(&self, content_id: &str) -> Result<Option<ContentMeta>> {
        let Some(bytes) = self.objects.read(&meta_key(content_id)).await? else {
            return Ok(None);
        };
        let meta = crate::json::from_slice(&bytes).with_context(|| format!("the meta file of {content_id} is not one"))?;
        Ok(Some(meta))
    }

    /// The size of the bytes as the store holds them, and their content type where it keeps
    /// one; none if `of` has no bytes.
    pub async fn stat_if_there(&self, of: BytesOwner<'_>) -> Result<Option<ObjectStat>> {
        self.objects.stat(&of.key()?).await
    }

    /// The bytes of `of`, whole; none if it has none. For what is small: a text, a link.
    pub async fn read(&self, of: BytesOwner<'_>) -> Result<Option<Vec<u8>>> {
        self.objects.read(&of.key()?).await
    }

    /// Copies the bytes of `of` to a local file, which is made, or written over: what the
    /// video worker reads a staged video with. Fails, with an error `is_not_found` knows, if
    /// `of` has none.
    pub async fn fetch_to(&self, of: BytesOwner<'_>, local: &Path) -> Result<()> {
        self.objects.fetch_to(&of.key()?, local).await
    }

    /// Deletes a post's bytes and its meta file, as far as it can. `images` is how many images
    /// its meta file says it has, for an image post of several: each is deleted with them.
    pub async fn remove(&self, content_id: &str, images: i64) -> Result<()> {
        let mut keys: Vec<String> = (1..=images.max(1)).map(|image| image_key(content_id, image)).collect();
        keys.push(meta_key(content_id));
        join_all(keys.iter().map(|key| self.objects.delete(key))).await;
        Ok(())
    }

    /// Deletes one image of an image post, by its place among the post's images: one after
    /// the first, which an update of the post left it without. One that isn't there is no error.
    pub async fn remove_image(&self, content_id: &str, image: i64) -> Result<()> {
        if image < 2 {
            bail!("image {image} of {content_id} is the post's bytes, which go with the post");
        }
        self.objects.delete(&image_key(content_id, image)).await
    }

    /// Deletes what the server made of a post's video beside the post's bytes: the poster and
    /// the stream of one version of it, or with none, of every version there is, which is what
    /// goes with the post. Nothing there is no error.
    pub async fn remove_media(&self, content_id: &str, video_id: Option<&str>) -> Result<()> {
        let prefix = match video_id {
            Some(video_id) if !is_id(video_id) => bail!("\"{video_id}\" is not the id of a video"),
            Some(video_id) => format!("{}{video_id}/", media_prefix(content_id)),
            None => media_prefix(content_id),
        };
        self.objects.remove_all(&prefix).await
    }

    /// Deletes the image of an ad, as far as it can. One that isn't there is no error.
    pub async fn remove_ad_image(&self, ad_id: &str) -> Result<()> {
        let _ = self.objects.delete(&ad_image_key(ad_id)).await;
        Ok(())
    }

    /// Deletes one avatar of a user's. One that isn't there is no error.
    pub async fn remove_avatar(&self, user_id: &str, avatar_id: &str) -> Result<()> {
        self.objects.delete(&BytesOwner::Avatar { user_id, avatar: avatar_id }.key()?).await
    }

    /// Deletes every avatar the store holds of a user: what goes with the account. Nothing
    /// there is no error.
    pub async fn remove_avatars(&self, user_id: &str) -> Result<()> {
        self.objects.remove_all(&avatar_prefix(user_id)).await
    }

    /// Deletes one splash image of a user's. One that isn't there is no error.
    pub async fn remove_splash(&self, user_id: &str, splash_id: &str) -> Result<()> {
        self.objects.delete(&BytesOwner::Splash { user_id, splash: splash_id }.key()?).await
    }

    /// Deletes every splash image the store holds of a user: what goes with the account.
    /// Nothing there is no error.
    pub async fn remove_splashes(&self, user_id: &str) -> Result<()> {
        self.objects.remove_all(&splash_prefix(user_id)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0198c0de-0000-7000-8000-000000000001";

    #[test]
    fn knows_the_files_of_a_video_by_their_names() {
        for file in ["poster.jpg", "master.m3u8", "720p.m3u8", "1080p.m3u8", "240p_00001.ts"] {
            assert!(is_media_file(file), "{file}");
        }
        for file in [
            "",
            "poster.png",
            "72p.m3u8",
            "10800p.m3u8",
            "720p_1.ts",
            "720p_000001.ts",
            "720p_00001.mp4",
            "../x",
            "720p.m3u8\n",
        ] {
            assert!(!is_media_file(file), "{file}");
        }
    }

    #[test]
    fn keeps_each_owners_bytes_where_the_api_reads_them() {
        assert_eq!(BytesOwner::Post(ID).key().unwrap(), format!("content/{ID}"));
        assert_eq!(BytesOwner::Image { content_id: ID, image: 1 }.key().unwrap(), format!("content/{ID}"));
        assert_eq!(BytesOwner::Image { content_id: ID, image: 3 }.key().unwrap(), format!("content/{ID}.3"));
        assert_eq!(
            BytesOwner::Video {
                content_id: "c",
                video: ID,
                file: "poster.jpg"
            }
            .key()
            .unwrap(),
            format!("media/c/{ID}/poster.jpg")
        );
        assert_eq!(BytesOwner::Staged(&staged_key(ID)).key().unwrap(), format!("staged/{ID}"));
        assert!(BytesOwner::Staged("staged/../content/x").key().is_err());
        assert!(BytesOwner::Staged(&format!("content/{ID}")).key().is_err());
        assert!(
            BytesOwner::Video {
                content_id: "c",
                video: "v",
                file: "poster.jpg"
            }
            .key()
            .is_err()
        );
        assert!(BytesOwner::Avatar { user_id: "u", avatar: "../x" }.key().is_err());
        assert_eq!(BytesOwner::Splash { user_id: "u", splash: ID }.key().unwrap(), format!("splashes/u/{ID}"));
        assert!(BytesOwner::Splash { user_id: "u", splash: "../x" }.key().is_err());
    }
}
