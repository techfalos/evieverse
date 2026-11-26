//! Known child sexual abuse material: an image whose PDQ hash is near one on the operator's
//! list of hashes of such material isn't trusted at all, and the server's admins are told of
//! it, with what a report to the authorities is written from (see `report`). Every image of
//! an image post is checked, new or an update, the image a comment comes with, and the avatar
//! a user gives their profile.
//!
//! PDQ is the perceptual hash Meta published for this (see hash.rs): the hash of a picture
//! stays nearly the same when it is resized, compressed again or lightly edited, so a copy is
//! found that isn't the same file. Two hashes are of the same picture when they differ in at
//! most `pdq.maxDistance` of their 256 bits. An image with too little in it to tell it by
//! (one colour, a plain gradient: a quality under `pdq.minQuality`) isn't matched, since its
//! hash is near that of every other such image. Each frame of an animated image is hashed as
//! a picture of its own, up to its 32nd.
//!
//! The list is the operator's to get (`pdq.hashList`, PDQ_HASH_LIST): hashes of this material
//! aren't published, and are given to platforms by the bodies that keep them. Each process
//! holds it in memory (see `KnownHashes`), so an image is checked against what the list had
//! when it was sent. Nothing of an image, and no hash, is sent to anyone.
//!
//! What a match leads to is the score's doing: 0, which the server's thresholds refuse
//! unless it deletes nothing on arrival, and then hold in the moderation queue. The sender is
//! told what anyone whose post isn't trusted is told, and not why: no reason is given. On a
//! server that has a quarantine (QUARANTINE_SCHEME) the file that matched is kept there, for
//! the report its operator may have to make of it, where only an admin reads it; on any
//! other, nothing of it is kept.
//!
//! The plugin is optional: it runs on a server that names it in TRUST_OPTIONAL_PLUGINS, and
//! on no other. Where it runs, no image is published unchecked. While the process has no
//! list, because its first reading failed, a post or a comment with an image fails, as a
//! plugin that fails has it; one without an image is stored whatever the list does. An image
//! that can't be decoded, so that there is nothing to hash, is given a score just under the
//! one that publishes: it waits in the moderation queue for a person to look at, or is
//! refused with the reason where the server has no queue. An avatar has no queue to wait in:
//! it is refused either way, a match and an image that can't be decoded alike.
//!
//! A video is not the plugin's to check, as its pictures aren't there to read while its
//! request waits: the video worker checks it before anything of it is published, on a server
//! that processes videos (VIDEO_PROCESSING).
//!
//! What it doesn't see: an audio file, a video on a server that publishes videos as they are
//! sent, an image that was mirrored, rotated or cropped far (its hash is another), the frames
//! of an animation past the 32nd, an ad's image, and the image of a repost of a post on
//! another server, which this server never holds.

pub mod hash;
pub mod image;
pub mod list;
pub mod report;
pub mod video;

use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde_json::json;

use self::hash::{PdqHash, pdq_hash, to_hex};
use self::image::{UnreadableImage, frames_of};
use self::list::{KnownHashes, Match, nearest};
use self::report::{Found, Sent, report};
use crate::trust::{MIN_TRUST_SCORE, TrustChange, TrustContext, TrustPlugin, TrustPost, msg};

struct Pdq {
    known: Arc<KnownHashes>,
}

/// The first frame of an image that matches, and how.
struct Matched {
    found: Match,
    hash: PdqHash,
    frame: usize,
}

#[async_trait]
impl TrustPlugin for Pdq {
    fn optional(&self) -> bool {
        true
    }

    fn reads_images(&self) -> bool {
        true
    }

    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        if post.images.is_empty() {
            // Nothing to check, but the list is kept current for the post that has.
            self.known.refresh(ctx);
            return Ok(None);
        }
        let list = self.known.get(ctx).await?;
        let (most, least) = (u32::try_from(ctx.config.pdq.max_distance).unwrap_or(0), ctx.config.pdq.min_quality);
        let mut unreadable = false;
        for image in &post.images {
            let (file, list) = (image.file.clone(), list.clone());
            // Decoding an image and hashing its frames is work that takes its thread a while:
            // it is given one that may be kept, and the others go on answering.
            let read = tokio::task::spawn_blocking(move || {
                frames_of(&file, |frame, mut read| {
                    let hash = pdq_hash(&mut read.luma, read.rows, read.cols);
                    if hash.quality < least {
                        return None;
                    }
                    nearest(&list, &hash.words, most).map(|found| Matched { found, hash, frame })
                })
            })
            .await
            .context("an image could not be read for its hash")?;
            match read {
                Ok(Some(Matched { found, hash, frame })) => {
                    let sent = Sent { user_id: post.user_id.clone(), content_id: post.content_id.clone(), comment_on: post.comment_on.clone(), profile: post.profile, created: None };
                    let found = Found { listed: found.listed, distance: found.distance, image: image.clone(), pdq: to_hex(&hash.words), quality: hash.quality, frame, video: None };
                    report(&sent, ctx, &found).await;
                    return Ok(Some(TrustChange::set(MIN_TRUST_SCORE)));
                }
                Ok(None) => {}
                Err(UnreadableImage(why)) => {
                    unreadable = true;
                    ctx.log.warn(
                        json!({ "err": { "type": "UnreadableImage", "message": format!("the image can't be decoded: {why}") }, "userId": post.user_id, "filename": image.filename, "mimeType": image.mime_type }),
                        "pdq: an image couldn't be decoded, so it wasn't checked against the list",
                    );
                }
            }
        }
        if !unreadable {
            return Ok(None);
        }
        // Just under what publishes: held for a person to look at, or refused where the server has no queue.
        let key = if post.profile {
            "user.avatar_unreadable"
        } else if post.comment_on.is_none() {
            "moderation.image_unreadable"
        } else {
            "comment.image_unreadable"
        };
        Ok(Some(TrustChange::set(ctx.config.trust.allow_from - 1).because(msg(key))))
    }
}

/// The plugin, as the registry asks for it (see build.rs), with a list of its own.
pub fn plugin() -> Box<dyn TrustPlugin> {
    sharing(Arc::new(KnownHashes::default()))
}

/// The plugin, checking against a list that something else of the process holds too (the
/// video worker), so that the list is held once.
pub fn sharing(known: Arc<KnownHashes>) -> Box<dyn TrustPlugin> {
    Box::new(Pdq { known })
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use ::image::ImageFormat;
    use evieverse_core::log::Level;
    use evieverse_core::testing;
    use serde_json::Value;

    use super::image::tests::{picture, written};
    use super::*;
    use crate::trust::tests::World;
    use crate::trust::{TrustClient, TrustImage};

    /// The hash of the image in a file, as it is written.
    fn hash_of(path: &Path) -> String {
        frames_of(path, |_, mut frame| Some(to_hex(&pdq_hash(&mut frame.luma, frame.rows, frame.cols).words))).unwrap().unwrap()
    }

    fn image(path: &Path, name: &str) -> TrustImage {
        TrustImage { mime_type: "image/png".into(), filename: Some(name.into()), file: path.to_owned(), sha256: format!("sha-of-{name}") }
    }

    fn post(images: Vec<TrustImage>) -> TrustPost {
        TrustPost { user_id: "u1".into(), images, ..TrustPost::default() }
    }

    /// A server that runs the plugin with a list of the hashes of `listed`, and has an admin.
    async fn world(listed: &[&Path], more: Value) -> (World, PathBuf) {
        // Beside the images, in the folder of the test that made them.
        let list = listed[0].with_file_name("hashes.txt");
        std::fs::write(&list, listed.iter().map(|path| hash_of(path)).chain(["# the end".to_owned()]).collect::<Vec<_>>().join("\n")).unwrap();
        let mut settings = json!({ "trust": { "optionalPlugins": ["pdq"] }, "pdq": { "hashList": list.to_string_lossy() } });
        for (name, value) in more.as_object().cloned().unwrap_or_default() {
            match (&mut settings[&name], value) {
                (Value::Object(into), Value::Object(from)) => into.extend(from),
                (into, value) => *into = value,
            }
        }
        let world = World::new(settings).await;
        testing::user(&world.db, "u1", "sender", false).await;
        testing::user(&world.db, "a1", "admin-one", true).await;
        testing::user(&world.db, "a2", "admin-two", true).await;
        (world, list)
    }

    async fn notices(world: &World) -> Vec<(String, String, Option<String>, Value)> {
        let rows = world.db.fetch("SELECT user_id, kind, content_id, body FROM inbox ORDER BY user_id, created_at", &[]).await.unwrap();
        rows.iter()
            .map(|row| (row.string("user_id").unwrap(), row.string("kind").unwrap(), row.opt_string("content_id").unwrap(), serde_json::from_str(row.str("body").unwrap()).unwrap()))
            .collect()
    }

    #[tokio::test]
    async fn an_image_near_a_listed_hash_is_not_trusted_and_the_admins_are_told() {
        let files = tempfile::tempdir().unwrap();
        let known = written(files.path(), "known.png", &picture(300, 200, 1), ImageFormat::Png);
        // The same picture, smaller and compressed again: another file, and the same picture.
        let copy = written(files.path(), "copy.jpg", &picture(150, 100, 1), ImageFormat::Jpeg);
        let other = written(files.path(), "other.png", &picture(300, 200, 2), ImageFormat::Png);
        let (mut world, _) = world(&[&known], json!({})).await;
        world.client = Some(TrustClient { ip: "203.0.113.9".into(), user_agent: Some("a\tclient".into()) });
        let plugin = plugin();
        assert!(plugin.optional() && plugin.reads_images());

        assert_eq!(plugin.assess(&post(vec![image(&other, "other.png")]), &world.ctx()).await.unwrap(), None);
        assert_eq!(plugin.assess(&post(vec![]), &world.ctx()).await.unwrap(), None);
        assert!(notices(&world).await.is_empty());
        world.said();

        // No reason: the sender is told what anyone whose post isn't trusted is told.
        let refused = plugin.assess(&post(vec![image(&other, "other.png"), image(&copy, "copy.jpg")]), &world.ctx()).await.unwrap();
        assert_eq!(refused, Some(TrustChange::set(0)));
        let told = notices(&world).await;
        assert_eq!(told.iter().map(|(user, kind, content, _)| (user.as_str(), kind.as_str(), content.clone())).collect::<Vec<_>>(), [("a1", "csam_match_refused", None), ("a2", "csam_match_refused", None)]);
        let facts = &told[0].3;
        assert_eq!(facts["userId"], "u1");
        assert_eq!(facts["listed"], hash_of(&known));
        assert_eq!(facts["username"], "sender");
        assert_eq!(facts["at"], "2026-11-06T12:00:00.000Z");
        assert_eq!(facts["ip"], "203.0.113.9");
        assert_eq!(facts["userAgent"], "a client");
        assert_eq!(facts["sentAs"], "post");
        assert_eq!(facts["filename"], "copy.jpg");
        assert_eq!(facts["sha256"], "sha-of-copy.jpg");
        assert_eq!(facts["pdq"], hash_of(&copy));
        assert_eq!(facts["frame"], 0);
        assert_eq!(facts["outcome"], "refused");
        assert!(facts["distance"].as_u64().unwrap() <= 31 && facts.get("contentId").is_none() && facts.get("quarantineId").is_none(), "{facts}");
        // In the order a notice is told from another by.
        let body = world.db.fetch("SELECT body FROM inbox", &[]).await.unwrap()[0].string("body").unwrap();
        assert!(body.starts_with(&format!("{{\"userId\":\"u1\",\"listed\":\"{}\",", hash_of(&known))), "{body}");
        let said = world.said();
        assert_eq!(said.len(), 1);
        assert_eq!(said[0].0, Level::Warn);
        assert_eq!(said[0].2["match"], *facts);

        // Sent again: the log has each time, and an admin with an unread notice gets no second one.
        world.db.execute("UPDATE inbox SET read_at = 5 WHERE user_id = 'a2'", &[]).await.unwrap();
        let comment = TrustPost { comment_on: Some("p9".into()), ..post(vec![image(&copy, "copy.jpg")]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap(), Some(TrustChange::set(0)));
        let told = notices(&world).await;
        assert_eq!(told.iter().map(|(user, ..)| user.as_str()).collect::<Vec<_>>(), ["a1", "a2", "a2"]);
        assert_eq!((told[2].3["sentAs"].as_str(), told[2].2.as_deref()), (Some("comment"), Some("p9")));
        assert_eq!(world.said().len(), 1);
    }

    #[tokio::test]
    async fn a_match_is_held_where_nothing_is_deleted_on_arrival_and_kept_where_there_is_a_quarantine() {
        let files = tempfile::tempdir().unwrap();
        let known = written(files.path(), "known.png", &picture(300, 200, 1), ImageFormat::Png);
        let root = files.path().join("quarantine");
        let (world, _) = world(&[&known], json!({ "trust": { "deleteBelow": 0 }, "quarantine": { "scheme": "fs", "options": { "root": root.to_string_lossy() } } })).await;
        let plugin = plugin();

        let update = TrustPost { content_id: Some("p1".into()), ..post(vec![image(&known, "known.png")]) };
        assert_eq!(plugin.assess(&update, &world.ctx()).await.unwrap(), Some(TrustChange::set(0)));
        let told = notices(&world).await;
        assert_eq!((told[0].1.as_str(), told[0].2.as_deref()), ("csam_match_held", Some("p1")));
        let facts = &told[0].3;
        assert_eq!((facts["outcome"].as_str(), facts["sentAs"].as_str(), facts["distance"].as_u64(), facts["ip"].as_str()), (Some("held"), Some("update"), Some(0), Some("unknown")));
        let kept = facts["quarantineId"].as_str().unwrap();
        assert_eq!(std::fs::read(root.join("files").join(kept)).unwrap(), std::fs::read(&known).unwrap());
        let row = world.db.fetch_optional("SELECT * FROM quarantine", &[]).await.unwrap().unwrap();
        assert_eq!((row.str("id").unwrap(), row.str("user_id").unwrap(), row.str("sha256").unwrap(), row.i64("matches").unwrap()), (kept, "u1", "sha-of-known.png", 1));

        // An avatar is refused whatever the thresholds are.
        let avatar = TrustPost { profile: true, ..post(vec![image(&known, "known.png")]) };
        assert_eq!(plugin.assess(&avatar, &world.ctx()).await.unwrap(), Some(TrustChange::set(0)));
        assert_eq!(world.db.fetch_optional("SELECT matches FROM quarantine", &[]).await.unwrap().unwrap().i64("matches").unwrap(), 2);
    }

    #[tokio::test]
    async fn an_image_that_cannot_be_decoded_waits_for_a_person_and_one_with_nothing_in_it_is_not_matched() {
        let files = tempfile::tempdir().unwrap();
        let known = written(files.path(), "known.png", &picture(300, 200, 1), ImageFormat::Png);
        let plain = written(files.path(), "plain.png", &::image::RgbImage::from_pixel(100, 100, ::image::Rgb([40, 40, 40])), ImageFormat::Png);
        let broken = files.path().join("broken.png");
        std::fs::write(&broken, "not an image").unwrap();
        // A list that holds the hash of the plain image too: its quality is what keeps it from matching.
        let (world, _) = world(&[&known, &plain], json!({ "trust": { "allowFrom": 80 } })).await;
        let plugin = plugin();

        assert_eq!(plugin.assess(&post(vec![image(&plain, "plain.png")]), &world.ctx()).await.unwrap(), None);
        world.said();
        let held = plugin.assess(&post(vec![image(&broken, "broken.png")]), &world.ctx()).await.unwrap();
        assert_eq!(held, Some(TrustChange::set(79).because(msg("moderation.image_unreadable"))));
        let said = world.said();
        assert_eq!((said[0].0, said[0].2["filename"].as_str()), (Level::Warn, Some("broken.png")));
        let comment = TrustPost { comment_on: Some("p1".into()), ..post(vec![image(&broken, "b")]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap().unwrap().reason, Some(msg("comment.image_unreadable")));
        let avatar = TrustPost { profile: true, ..post(vec![image(&broken, "b")]) };
        assert_eq!(plugin.assess(&avatar, &world.ctx()).await.unwrap().unwrap().reason, Some(msg("user.avatar_unreadable")));
        // One that matches, after one that can't be read, is a match.
        let both = post(vec![image(&broken, "b"), image(&known, "known.png")]);
        assert_eq!(plugin.assess(&both, &world.ctx()).await.unwrap(), Some(TrustChange::set(0)));
        assert!(notices(&world).await.len() == 2);
    }

    #[tokio::test]
    async fn without_a_list_a_post_with_an_image_fails_and_one_without_is_let_through() {
        let files = tempfile::tempdir().unwrap();
        let known = written(files.path(), "known.png", &picture(300, 200, 1), ImageFormat::Png);
        let (world, list) = world(&[&known], json!({})).await;
        std::fs::write(&list, format!("{}\n{}\n", "0".repeat(64), "f".repeat(64))).unwrap();
        let plugin = plugin();
        let err = plugin.assess(&post(vec![image(&known, "known.png")]), &world.ctx()).await.unwrap_err();
        assert!(err.to_string().contains("the pdq trust plugin has no list of hashes to check images with") && err.to_string().contains("doesn't hold PDQ hashes"), "{err}");
        assert_eq!(plugin.assess(&post(vec![]), &world.ctx()).await.unwrap(), None);
        let said = world.said();
        assert_eq!((said[0].0, &said[0].2["stale"]), (Level::Error, &json!(false)));
    }
}
