//! Images made with AI: an image that carries a SynthID watermark lowers the trust of what it
//! comes with. SynthID is the mark some generators of images put in what they make: it can't
//! be seen, it is part of the picture and not of the file's metadata, and it stays through
//! most of what is done to a picture afterwards. Every image of an image post is checked, new
//! or an update, the image a comment comes with, and the avatar and the splash image a user
//! gives their profile.
//!
//! The server can't read the mark itself: only a detector its makers run can. So each image
//! is sent to one (`synthid.url`, SYNTHID_URL), as the server would store it, which is
//! without its metadata, and without the name it was sent with. The detector is OpenAI's
//! Content Provenance API unless the operator names another that takes a request and answers
//! as it does. That API finds the marks of images made with OpenAI's models, and of no other
//! maker's: Google, whose mark SynthID is, has no detector a server can ask.
//!
//! What a watermark leads to is the operator's to say (`synthid.action`, SYNTHID_ACTION).
//! `hold`, which is the default, gives a score just under the one that publishes: a post or a
//! comment waits in the moderation queue for a person to look at, as the detector's makers
//! ask of what is decided by its answer, and is refused where the server has no queue. A
//! profile has no queue to wait in, and is refused. `refuse` gives a score of 0. Either way
//! the sender is told why.
//!
//! An image the detector couldn't check (it couldn't be reached, it took no more requests,
//! which it limits, or it didn't read the file) is the operator's to say too
//! (`synthid.unchecked`, SYNTHID_UNCHECKED): `hold`, the default, holds it as a watermark is
//! held, so that no image is published unchecked, and `allow` lets it through. The log is
//! told either way.
//!
//! The plugin is optional: it runs on a server that names it in TRUST_OPTIONAL_PLUGINS, which
//! then needs a key to ask the detector with (`synthid.apiKey`, SYNTHID_API_KEY), and on no
//! other.
//!
//! What it doesn't see: an image made by a generator that leaves no SynthID watermark, or
//! whose watermark the detector doesn't read; one whose watermark was worn away; a text, a
//! video and an audio file; an ad's image; the image of a comment that is edited, since an
//! edit keeps the file; and the image of a repost of a post on another server, which this
//! server never holds. An image with no watermark is not thereby one a person made.
//!
//! What a sender declares of their own post or comment (`aiGenerated`) changes nothing, unless
//! the operator says it does (`synthid.allowDisclosed`, SYNTHID_ALLOW_DISCLOSED): a watermark
//! counts the same with the declaration and without it. On a server that says so, what is
//! declared as created with AI is left as it is, and none of its images is sent: the detector
//! would find out nothing its sender didn't say. A profile's image comes with no declaration,
//! and is checked on every server.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use evieverse_core::config::SynthidConfig;
use futures::stream::{self, StreamExt};
use serde_json::{Value, json};

use crate::lines;
use crate::trust::{MIN_TRUST_SCORE, Reason, TrustChange, TrustContext, TrustImage, TrustPlugin, TrustPost, msg};

/// How long the detector may take over one image. The request that sent the image waits.
const CHECK: Duration = Duration::from_secs(15);

/// How many of a post's images the detector is asked about at once.
const AT_ONCE: usize = 4;

/// What the sender is told of an image with a watermark: on a profile, on a post, on a comment.
const WATERMARKED: [&str; 3] = ["user.profile_ai_watermark", "moderation.ai_watermark", "comment.ai_watermark"];

/// What the sender is told of an image that couldn't be checked, in the same order.
const UNCHECKED: [&str; 3] = ["user.profile_image_unchecked", "moderation.image_unchecked", "comment.image_unchecked"];

/// What the detector found in an image.
#[derive(Debug, PartialEq)]
enum Checked {
    /// A watermark, with the model that made the image and when, where the detector says.
    Watermarked { model: Value, generated_at: Value },
    Clear,
}

/// Why an image wasn't checked.
#[derive(Debug, PartialEq)]
struct Unchecked {
    why: String,
    /// Whether the detector took no more requests for now, which is nobody's mistake.
    busy: bool,
}

impl Unchecked {
    fn because(why: impl Into<String>) -> Self {
        Self { why: why.into(), busy: false }
    }
}

#[derive(Default)]
struct Synthid {
    /// What the detector is asked with, made when the first image is checked and kept.
    client: OnceLock<reqwest::Client>,
}

impl Synthid {
    /// A redirect isn't followed: an image goes to the address the operator named, and no further.
    fn client(&self) -> Result<&reqwest::Client> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|err| anyhow!("the synthid trust plugin could not set up its requests: {}", err.without_url()))?;
        Ok(self.client.get_or_init(|| client))
    }
}

/// Asks the detector about one image: a form whose `file` is the image, which it answers
/// with what it found, each kind of mark as a result of its own. The key is in a header,
/// and in no error.
async fn check(client: &reqwest::Client, config: &SynthidConfig, key: &str, image: &TrustImage) -> Result<Checked, Unchecked> {
    let extension = match image.mime_type.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        other => return Err(Unchecked::because(format!("{other} is not a type of image the detector reads"))),
    };
    let bytes = tokio::fs::read(&image.file).await.map_err(|err| Unchecked::because(format!("the image could not be read to send it: {err}")))?;
    // The form, written here: one part, named after its type and not as its sender named it.
    let boundary = format!("evieverse-{}", uuid::Uuid::new_v4().simple());
    let mut body =
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.{extension}\"\r\nContent-Type: {}\r\n\r\n", image.mime_type).into_bytes();
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let asking = async {
        let response = client
            .post(&config.url)
            .bearer_auth(key)
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .header("user-agent", "evieverse (synthid trust plugin)")
            .body(body)
            .send()
            .await
            .map_err(|err| Unchecked::because(format!("the detector could not be asked: {}", lines::cause(&err.without_url()))))?;
        let status = response.status().as_u16();
        let answer = response.bytes().await.map_err(|err| Unchecked::because(format!("the detector's answer stopped arriving: {}", lines::cause(&err.without_url()))))?;
        Ok((status, answer))
    };
    let (status, answer) =
        tokio::time::timeout(CHECK, asking).await.map_err(|_| Unchecked::because(format!("the detector took more than {} seconds to answer", CHECK.as_secs())))??;
    let said = serde_json::from_slice::<Value>(&answer).ok();

    if !(200..300).contains(&status) {
        // Its own word for what went wrong, where it gave one.
        let code = said.as_ref().and_then(|said| said["error"]["code"].as_str()).filter(|code| code.len() <= 64).map(|code| format!(" ({code})")).unwrap_or_default();
        let hint = match status {
            401 | 403 => ": it refused the API key (SYNTHID_API_KEY)",
            404 => ": the key's account has no access to it, or SYNTHID_URL is not its address",
            429 => ": it takes no more requests for now",
            _ => "",
        };
        return Err(Unchecked { why: format!("the detector answered {status}{code}{hint}"), busy: status == 429 });
    }
    let Some(said) = said else {
        return Err(Unchecked::because("what the detector answered is not JSON: is SYNTHID_URL its address?"));
    };
    let found = said["results"].as_array().and_then(|results| results.iter().find(|result| result["type"] == "synthid"));
    match found.map(|found| (found, found["outcome"].as_str())) {
        Some((found, Some("detected"))) => Ok(Checked::Watermarked { model: found["model"].clone(), generated_at: found["generated_at"].clone() }),
        Some((_, Some("not_detected"))) => Ok(Checked::Clear),
        _ => Err(Unchecked::because("what the detector answered says nothing of a SynthID watermark")),
    }
}

/// One of three messages, by what the image came with: a profile, a post or a comment.
fn told(post: &TrustPost, [profile, a_post, comment]: [&str; 3]) -> Reason {
    msg(if post.profile {
        profile
    } else if post.comment_on.is_none() {
        a_post
    } else {
        comment
    })
}

#[async_trait]
impl TrustPlugin for Synthid {
    fn optional(&self) -> bool {
        true
    }

    fn reads_images(&self) -> bool {
        true
    }

    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        if post.images.is_empty() {
            return Ok(None);
        }
        let config = &ctx.config.synthid;
        // Declared as created with AI, on a server that takes its sender's word for it: there is nothing to find out.
        if config.allow_disclosed && post.ai_generated {
            return Ok(None);
        }
        let key = config.api_key.as_deref().context("the synthid trust plugin has no API key to ask the detector with: SYNTHID_API_KEY is not set")?;
        let client = self.client()?;
        // Just under what publishes: held for a person to look at, or refused where there is no queue.
        let held = ctx.config.trust.allow_from - 1;
        let about = |image: &TrustImage| json!({ "userId": post.user_id, "filename": image.filename, "mimeType": image.mime_type, "sha256": image.sha256 });

        // In their order, a few at a time. The first watermark is the answer, and the rest aren't waited for.
        let mut asked = Vec::with_capacity(post.images.len());
        for image in &post.images {
            asked.push(async move { (image, check(client, config, key, image).await) });
        }
        let mut checks = stream::iter(asked).buffered(AT_ONCE);
        let mut unchecked = false;
        while let Some((image, found)) = checks.next().await {
            match found {
                Ok(Checked::Watermarked { model, generated_at }) => {
                    let mut fields = about(image);
                    fields["model"] = model;
                    fields["generatedAt"] = generated_at;
                    ctx.log.info(fields, "synthid: an image carries a SynthID watermark");
                    let score = if config.action == "refuse" { MIN_TRUST_SCORE } else { held };
                    return Ok(Some(TrustChange::set(score).because(told(post, WATERMARKED))));
                }
                Ok(Checked::Clear) => {}
                Err(Unchecked { why, busy }) => {
                    unchecked = true;
                    let mut fields = about(image);
                    fields["err"] = json!({ "type": "UncheckedImage", "message": why });
                    fields["allowed"] = json!(config.unchecked == "allow");
                    let said = "synthid: an image couldn't be checked for a SynthID watermark";
                    if busy { ctx.log.warn(fields, said) } else { ctx.log.error(fields, said) }
                }
            }
        }
        if !unchecked || config.unchecked == "allow" {
            return Ok(None);
        }
        Ok(Some(TrustChange::set(held).because(told(post, UNCHECKED))))
    }
}

/// The plugin, as the registry asks for it (see build.rs).
pub fn plugin() -> Box<dyn TrustPlugin> {
    Box::new(Synthid::default())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use evieverse_core::log::Level;

    use super::*;
    use crate::trust::tests::{Served, World};

    const DETECTED: &str = r#"{"object":"content_provenance_check","created_at":1778000000,"results":[{"type":"c2pa","outcome":"not_detected","validation_state":"not_present","issuer":null,"model":null,"generated_at":null},{"type":"synthid","outcome":"detected","model":"gpt-image","generated_at":null}]}"#;
    const NOT_DETECTED: &str = r#"{"object":"content_provenance_check","created_at":1778000000,"results":[{"type":"c2pa","outcome":"detected","validation_state":"trusted"},{"type":"synthid","outcome":"not_detected","model":null,"generated_at":null}]}"#;

    /// An image's file, with these bytes: the plugin sends them, and reads nothing of them.
    fn file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn image(path: &Path, mime_type: &str) -> TrustImage {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        TrustImage { mime_type: mime_type.into(), sha256: format!("sha-of-{name}"), filename: Some(name), file: path.to_owned() }
    }

    fn post(images: Vec<TrustImage>) -> TrustPost {
        TrustPost { user_id: "u1".into(), images, ..TrustPost::default() }
    }

    /// A server that runs the plugin, asking `served`, with these of the plugin's settings and of trust's.
    async fn running(served: &Served, synthid: Value, trust: Value) -> World {
        let mut settings = json!({ "trust": { "optionalPlugins": ["synthid"] }, "synthid": { "apiKey": "sk-secret", "url": format!("{}/v1/content_provenance_checks", served.url) } });
        for (name, more) in [("synthid", synthid), ("trust", trust)] {
            settings[name].as_object_mut().unwrap().extend(more.as_object().cloned().unwrap_or_default());
        }
        World::new(settings).await
    }

    #[tokio::test]
    async fn an_image_with_a_watermark_is_held_for_a_person_or_refused_where_the_server_says_so() {
        let files = tempfile::tempdir().unwrap();
        let made = image(&file(files.path(), "holiday.png", b"the bytes of a picture"), "image/png");
        let served = Served::start(200, DETECTED).await;
        let world = running(&served, json!({}), json!({})).await;
        let plugin = plugin();
        assert!(plugin.optional() && plugin.reads_images());

        // Just under the 75 a post is published from, with what its sender is told where that refuses it.
        let held = |key: &str| Some(TrustChange::set(74).because(msg(key)));
        assert_eq!(plugin.assess(&post(vec![made.clone()]), &world.ctx()).await.unwrap(), held("moderation.ai_watermark"));
        let comment = TrustPost { comment_on: Some("p1".into()), ..post(vec![made.clone()]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap(), held("comment.ai_watermark"));
        let avatar = TrustPost { profile: true, ..post(vec![made.clone()]) };
        assert_eq!(plugin.assess(&avatar, &world.ctx()).await.unwrap(), held("user.profile_ai_watermark"));

        // The image as it is, in a form, with the key in a header, and not under the name it was sent with.
        let requests = served.requests();
        assert_eq!(requests.len(), 3);
        let asked = &requests[0];
        assert!(asked.starts_with("POST /v1/content_provenance_checks "), "{asked}");
        assert!(asked.to_lowercase().contains("authorization: bearer sk-secret\r\n"), "{asked}");
        assert!(asked.to_lowercase().contains("content-type: multipart/form-data; boundary=evieverse-"), "{asked}");
        assert!(asked.contains("Content-Disposition: form-data; name=\"file\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\nthe bytes of a picture\r\n--evieverse-"), "{asked}");
        assert!(!asked.contains("holiday"), "{asked}");
        // The log is told which image, and what the detector said of it.
        let said = world.said();
        assert_eq!(said.len(), 3);
        assert_eq!((said[0].0, &said[0].2), (Level::Info, &json!({ "userId": "u1", "filename": "holiday.png", "mimeType": "image/png", "sha256": "sha-of-holiday.png", "model": "gpt-image", "generatedAt": null })));

        // A server that refuses them gives no trust at all, and one with its own threshold holds under that.
        let refusing = running(&served, json!({ "action": "refuse" }), json!({})).await;
        assert_eq!(plugin.assess(&post(vec![made.clone()]), &refusing.ctx()).await.unwrap(), Some(TrustChange::set(0).because(msg("moderation.ai_watermark"))));
        let stricter = running(&served, json!({}), json!({ "allowFrom": 90 })).await;
        assert_eq!(plugin.assess(&post(vec![made]), &stricter.ctx()).await.unwrap(), Some(TrustChange::set(89).because(msg("moderation.ai_watermark"))));
    }

    #[tokio::test]
    async fn an_image_without_one_is_left_as_it_is_and_nothing_is_asked_about_a_post_with_no_image() {
        let files = tempfile::tempdir().unwrap();
        let served = Served::start(200, NOT_DETECTED).await;
        let world = running(&served, json!({ "action": "refuse" }), json!({})).await;
        let plugin = plugin();

        let album = post(vec![image(&file(files.path(), "one.jpg", b"one"), "image/jpeg"), image(&file(files.path(), "two.webp", b"two"), "image/webp"), image(&file(files.path(), "three.gif", b"three"), "image/gif")]);
        assert_eq!(plugin.assess(&album, &world.ctx()).await.unwrap(), None);
        // Each image is asked about, as the type it is.
        let mut parts: Vec<String> = served.requests().iter().map(|asked| asked.split("filename=\"").nth(1).unwrap().split("\r\n\r\n").next().unwrap().to_owned()).collect();
        parts.sort();
        assert_eq!(parts, ["image.gif\"\r\nContent-Type: image/gif", "image.jpg\"\r\nContent-Type: image/jpeg", "image.webp\"\r\nContent-Type: image/webp"]);

        let text = TrustPost { user_id: "u1".into(), texts: vec!["made with AI".into()], ..TrustPost::default() };
        assert_eq!(plugin.assess(&text, &world.ctx()).await.unwrap(), None);
        assert_eq!(served.requests().len(), 3);
        assert!(world.said().is_empty());
    }

    #[tokio::test]
    async fn what_is_declared_as_created_with_ai_is_left_as_it_is_on_a_server_that_says_so() {
        let files = tempfile::tempdir().unwrap();
        let made = image(&file(files.path(), "holiday.png", b"a picture"), "image/png");
        let served = Served::start(200, DETECTED).await;
        let plugin = plugin();
        let declared = TrustPost { ai_generated: true, ..post(vec![made.clone()]) };
        let held = |key: &str| Some(TrustChange::set(74).because(msg(key)));

        // Unless the server says so, a watermark counts the same with the declaration.
        let world = running(&served, json!({}), json!({})).await;
        assert_eq!(plugin.assess(&declared, &world.ctx()).await.unwrap(), held("moderation.ai_watermark"));
        assert_eq!(served.requests().len(), 1);

        // On one that does, the post is left as it is, and so is a comment: nothing is sent, and nothing said.
        let allowing = running(&served, json!({ "allowDisclosed": true, "action": "refuse" }), json!({})).await;
        assert_eq!(plugin.assess(&declared, &allowing.ctx()).await.unwrap(), None);
        let comment = TrustPost { comment_on: Some("p1".into()), ..declared.clone() };
        assert_eq!(plugin.assess(&comment, &allowing.ctx()).await.unwrap(), None);
        assert_eq!(served.requests().len(), 1);
        assert!(allowing.said().is_empty());
        // A detector that is down holds nothing of it either.
        served.answer(500, "");
        assert_eq!(plugin.assess(&declared, &allowing.ctx()).await.unwrap(), None);

        // What isn't declared is checked as on any server.
        served.answer(200, DETECTED);
        assert_eq!(plugin.assess(&post(vec![made]), &allowing.ctx()).await.unwrap(), Some(TrustChange::set(0).because(msg("moderation.ai_watermark"))));
        assert_eq!(served.requests().len(), 2);
    }

    #[tokio::test]
    async fn an_image_that_could_not_be_checked_is_held_too_unless_the_server_lets_it_through() {
        let files = tempfile::tempdir().unwrap();
        let sent = image(&file(files.path(), "holiday.png", b"a picture"), "image/png");
        let served = Served::start(429, r#"{"error":{"code":"rate_limit_exceeded","message":"slow down"}}"#).await;
        let world = running(&served, json!({ "action": "refuse" }), json!({})).await;
        let plugin = plugin();

        // Held, whatever a watermark is done with: nobody knows that it has one.
        let held = |key: &str| Some(TrustChange::set(74).because(msg(key)));
        assert_eq!(plugin.assess(&post(vec![sent.clone()]), &world.ctx()).await.unwrap(), held("moderation.image_unchecked"));
        let said = world.said();
        assert_eq!(said.len(), 1);
        // A detector that takes no more requests is a warning; anything else is an error.
        assert_eq!((said[0].0, said[0].1.as_str()), (Level::Warn, "synthid: an image couldn't be checked for a SynthID watermark"));
        assert_eq!(said[0].2, json!({ "userId": "u1", "filename": "holiday.png", "mimeType": "image/png", "sha256": "sha-of-holiday.png", "err": { "type": "UncheckedImage", "message": "the detector answered 429 (rate_limit_exceeded): it takes no more requests for now" }, "allowed": false }));
        let comment = TrustPost { comment_on: Some("p1".into()), ..post(vec![sent.clone()]) };
        assert_eq!(plugin.assess(&comment, &world.ctx()).await.unwrap(), held("comment.image_unchecked"));
        let avatar = TrustPost { profile: true, ..post(vec![sent.clone()]) };
        assert_eq!(plugin.assess(&avatar, &world.ctx()).await.unwrap(), held("user.profile_image_unchecked"));
        world.said();

        // What else leaves an image unchecked, each said without the key.
        for (status, body, why) in [
            (401, r#"{"error":{"code":"invalid_api_key"}}"#, "the detector answered 401 (invalid_api_key): it refused the API key (SYNTHID_API_KEY)"),
            (404, "", "the detector answered 404: the key's account has no access to it, or SYNTHID_URL is not its address"),
            (400, r#"{"error":{"code":"unsupported_file"}}"#, "the detector answered 400 (unsupported_file)"),
            (302, "", "the detector answered 302"),
            (500, "<html>down</html>", "the detector answered 500"),
            (200, "<html>a page</html>", "what the detector answered is not JSON: is SYNTHID_URL its address?"),
            (200, r#"{"results":[{"type":"c2pa","outcome":"detected"}]}"#, "what the detector answered says nothing of a SynthID watermark"),
            (200, r#"{"results":[{"type":"synthid","outcome":"maybe"}]}"#, "what the detector answered says nothing of a SynthID watermark"),
        ] {
            served.answer(status, body);
            assert_eq!(plugin.assess(&post(vec![sent.clone()]), &world.ctx()).await.unwrap(), held("moderation.image_unchecked"), "{status} {body}");
            let said = world.said();
            assert_eq!((said.len(), said[0].0, said[0].2["err"]["message"].as_str()), (1, Level::Error, Some(why)));
            assert!(!said[0].2.to_string().contains("sk-secret"), "{}", said[0].2);
        }
        // An image of a type the detector has no name for isn't sent at all.
        let asked = served.requests().len();
        let other = image(&file(files.path(), "holiday.bmp", b"a picture"), "image/bmp");
        assert_eq!(plugin.assess(&post(vec![other]), &world.ctx()).await.unwrap(), held("moderation.image_unchecked"));
        assert_eq!(served.requests().len(), asked);
        world.said();

        // A server that lets them through: the image counts as one without a watermark, and the log is told all the same.
        let allowing = running(&served, json!({ "unchecked": "allow" }), json!({})).await;
        served.answer(500, "");
        assert_eq!(plugin.assess(&post(vec![sent.clone()]), &allowing.ctx()).await.unwrap(), None);
        let said = allowing.said();
        assert_eq!((said.len(), said[0].0, &said[0].2["allowed"]), (1, Level::Error, &json!(true)));
        // One it could check still counts for what it is.
        served.answer(200, DETECTED);
        assert_eq!(plugin.assess(&post(vec![sent]), &allowing.ctx()).await.unwrap(), Some(TrustChange::set(74).because(msg("moderation.ai_watermark"))));
    }

    #[tokio::test]
    async fn a_detector_that_cannot_be_reached_leaves_an_image_unchecked() {
        let files = tempfile::tempdir().unwrap();
        let sent = image(&file(files.path(), "holiday.png", b"a picture"), "image/png");
        // An address nothing listens at: one that was listened at, and is no more.
        let gone = {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            format!("http://{}/v1/content_provenance_checks", listener.local_addr().unwrap())
        };
        let world = World::new(json!({ "trust": { "optionalPlugins": ["synthid"] }, "synthid": { "apiKey": "sk-secret", "url": gone } })).await;
        let held = plugin().assess(&post(vec![sent]), &world.ctx()).await.unwrap();
        assert_eq!(held, Some(TrustChange::set(74).because(msg("moderation.image_unchecked"))));
        let said = world.said();
        assert_eq!(said[0].0, Level::Error);
        let why = said[0].2["err"]["message"].as_str().unwrap();
        assert!(why.starts_with("the detector could not be asked: "), "{why}");
        assert!(!why.contains("127.0.0.1") && !why.contains("sk-secret"), "{why}");
    }
}
