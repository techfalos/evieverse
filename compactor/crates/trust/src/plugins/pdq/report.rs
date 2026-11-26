//! Telling the server's admins that an image matched the list, or a picture of a video.

use evieverse_core::db::places;
use evieverse_core::log;
use evieverse_core::params;
use evieverse_core::quarantine::{QuarantineFile, quarantine_file, quarantines};
use evieverse_core::time::iso;
use serde::Serialize;
use serde_json::{Value, json};

use crate::trust::{MIN_TRUST_SCORE, TrustContext, TrustImage, TrustRoute, route_of};

/// The notice an admin is left of an image that matched and was refused (src/inbox.ts).
const REFUSED_KIND: &str = "csam_match_refused";
/// The notice of one that is held in the moderation queue.
const HELD_KIND: &str = "csam_match_held";
/// The notice an admin is left of a video that matched, which is always refused.
const VIDEO_KIND: &str = "csam_video_refused";
/// How much of a filename and of a User-Agent header a notice keeps, in characters: enough
/// to tell them by, and little enough that the notice fits an inbox row.
const MAX_TEXT_CHARS: usize = 160;
/// The longest body an inbox row keeps, in characters as the API counts them (src/inbox.ts).
const MAX_MESSAGE_CHARS: usize = 2000;

/// What was sent with the file that matched, as far as a report tells of it: a post, an
/// update, a comment or a profile, and whose.
#[derive(Debug, Clone, Default)]
pub struct Sent {
    /// Who sent it.
    pub user_id: String,
    /// The content an update writes over.
    pub content_id: Option<String>,
    /// For a comment: the post it is on.
    pub comment_on: Option<String>,
    /// True for an avatar, and for a splash image.
    pub profile: bool,
    /// True for a splash image, which a profile's image is otherwise not.
    pub splash: bool,
    /// For a new post whose file was found to match only once the post had an id, which is a
    /// video's: that post, which is deleted for it.
    pub created: Option<String>,
}

/// For a video, which is checked after its request was answered: where in it the picture
/// that matched is, in seconds, and when it was sent.
#[derive(Debug, Clone, Copy)]
pub struct InVideo {
    pub seconds: f64,
    pub sent_at: i64,
}

/// An image that matched the list, or a video of which a picture did, and how.
#[derive(Debug, Clone)]
pub struct Found {
    /// The hash on the list that the picture's is near.
    pub listed: String,
    /// How many of the 256 bits the two differ in.
    pub distance: u32,
    /// The file that matched: an image as the plugin read it, or for a video, the file as it
    /// was sent, which is described as an image is.
    pub image: TrustImage,
    /// The PDQ hash of the picture that matched, as it is written.
    pub pdq: String,
    /// That hash's quality, from 0 to 100.
    pub quality: i64,
    /// Which frame matched, from 0.
    pub frame: usize,
    pub video: Option<InVideo>,
}

/// What an admin is told of a match, and what a report of it to the authorities is written
/// from: the body of the notice in their inbox, as JSON. `userId` and `listed` come first,
/// in that order: a notice is told from another of the same user and listed hash by how its
/// body starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MatchFacts {
    user_id: String,
    listed: String,
    username: String,
    at: String,
    ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_agent: Option<String>,
    sent_as: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    mime_type: String,
    sha256: String,
    pdq: String,
    quality: i64,
    distance: u32,
    frame: usize,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    media: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seconds: Option<serde_json::Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quarantine_id: Option<String>,
}

/// `text` on one line, without its control characters, and no longer than MAX_TEXT_CHARS.
/// None for none.
fn brief(text: Option<&str>) -> Option<String> {
    let mut line = String::new();
    let mut gap = false;
    for c in text.unwrap_or("").chars() {
        if c.is_control() {
            gap = true;
            continue;
        }
        if gap {
            line.push(' ');
            gap = false;
        }
        line.push(c);
    }
    if gap {
        line.push(' ');
    }
    // By character, so the cut never splits one in two.
    let chars: Vec<char> = crate::lines::trim(&line).chars().collect();
    if chars.is_empty() {
        return None;
    }
    Some(if chars.len() > MAX_TEXT_CHARS { chars[..MAX_TEXT_CHARS - 1].iter().chain(&['…']).collect() } else { chars.into_iter().collect() })
}

/// A number of seconds as the API writes one: a whole number without a fraction.
fn number(seconds: f64) -> Option<serde_json::Number> {
    if seconds.fract() == 0.0 && seconds.abs() < 9e15 { Some(serde_json::Number::from(seconds as i64)) } else { serde_json::Number::from_f64(seconds) }
}

/// Tells the server's admins that an image matched the list, or a picture of a video: who
/// sent it, when and from where, what it was, and which listed hash it is near. That is what
/// a report to the authorities is written from (in the United States, to NCMEC's
/// CyberTipline), which is the operator's to make: the server reports nothing to anyone
/// itself.
///
/// On a server that has a quarantine (QUARANTINE_SCHEME) the file is kept there first, as
/// the plugin read it, and what the admins are told names it (`quarantineId`): a report has
/// the file sent with it, and the law may have it kept afterwards. A file that can't be kept
/// is logged as an error, and refused all the same. Without a quarantine nothing of the file
/// is kept.
///
/// The admins are told twice. The log gets a warning with the facts, whatever else happens.
/// And every admin gets a notice in their inbox (csam_match_refused or csam_match_held, or
/// csam_video_refused for a video), whose body is the facts as JSON. An admin who has an
/// unread notice of the same user and the same listed hash gets no second one, so sending a
/// file over and over doesn't fill their inbox: the log has each time, and the quarantine
/// counts them.
///
/// It never fails the request, which is refusing the file: a notice that can't be left is
/// logged as an error.
pub async fn report(post: &Sent, ctx: &TrustContext<'_>, found: &Found) {
    let TrustContext { db, config, log, client, .. } = *ctx;
    let now = (ctx.now)();
    // An avatar is refused whatever the thresholds are, and so is a splash image: a profile has
    // no moderation queue to hold it in. So is a video, which is found after its request was
    // answered.
    let refused = found.video.is_some() || post.profile || route_of(MIN_TRUST_SCORE, &config.trust) == TrustRoute::Delete;
    let kind = if found.video.is_some() {
        VIDEO_KIND
    } else if refused {
        REFUSED_KIND
    } else {
        HELD_KIND
    };
    let what = if found.video.is_some() { "a video" } else { "an image" };
    let content_id = post.content_id.clone().or_else(|| post.comment_on.clone()).or_else(|| post.created.clone());

    // Their name is left out where it can't be read: the file is kept, and the log told, with
    // their id, whatever the database does.
    let username = match db.fetch_optional("SELECT username FROM users WHERE id = ?", params![&post.user_id]).await {
        Ok(Some(row)) => row.string("username").unwrap_or_default(),
        _ => String::new(),
    };
    let mut facts = MatchFacts {
        user_id: post.user_id.clone(),
        listed: found.listed.clone(),
        username,
        at: iso(found.video.map_or(now, |video| video.sent_at)),
        ip: client.map_or_else(|| "unknown".to_owned(), |client| client.ip.clone()),
        user_agent: brief(client.and_then(|client| client.user_agent.as_deref())),
        sent_as: if post.profile && post.splash {
            "splash"
        } else if post.profile {
            "avatar"
        } else if post.comment_on.is_some() {
            "comment"
        } else if post.content_id.is_some() {
            "update"
        } else {
            "post"
        },
        content_id: content_id.clone(),
        filename: brief(found.image.filename.as_deref()),
        mime_type: found.image.mime_type.clone(),
        sha256: found.image.sha256.clone(),
        pdq: found.pdq.clone(),
        quality: found.quality,
        distance: found.distance,
        frame: found.frame,
        outcome: if refused { "refused" } else { "held" },
        media: found.video.map(|_| "video"),
        seconds: found.video.and_then(|video| number(video.seconds)),
        quarantine_id: None,
    };
    let as_json = |facts: &MatchFacts| serde_json::to_value(facts).unwrap_or(Value::Null);

    // The facts with the item the file is kept as, on a server that keeps it. They are as
    // they were if it can't be kept.
    if quarantines(config) {
        let said = as_json(&facts);
        let file = QuarantineFile { user_id: &post.user_id, path: &found.image.file, sha256: &found.image.sha256, mime_type: &found.image.mime_type, facts: &said };
        match quarantine_file(db, config, now, &file).await {
            Ok(kept) => facts.quarantine_id = kept,
            Err(err) => log.error(
                json!({ "err": log::err(&err), "match": said }),
                &format!("pdq: {what} matches the list of hashes of known child sexual abuse material, and couldn't be kept in the quarantine: nothing of the file is kept"),
            ),
        }
    }

    let told = async {
        let admins = db.fetch("SELECT id FROM users WHERE admin = 1 AND deleted_at IS NULL", &[]).await?;
        let admins = admins.iter().map(|row| row.string("id")).collect::<anyhow::Result<Vec<_>>>()?;
        log.warn(json!({ "match": as_json(&facts) }), &format!("pdq: {what} matches the list of hashes of known child sexual abuse material; the admins are told in their inboxes"));
        if admins.is_empty() {
            log.error(json!({ "match": as_json(&facts) }), "pdq: this server has no admin to tell of the match: make one (npm run admin)");
            return Ok(());
        }
        let mut body = serde_json::to_string(&facts)?;
        // What a client sent can't make the notice too long to keep.
        if body.encode_utf16().count() > MAX_MESSAGE_CHARS {
            body = serde_json::to_string(&MatchFacts { user_agent: None, filename: None, ..facts.clone() })?;
        }
        // How the body of every notice of this user and this listed hash starts.
        let start = format!("{{\"userId\":{},\"listed\":{},", serde_json::to_string(&facts.user_id)?, serde_json::to_string(&facts.listed)?);
        let mut values = vec![];
        values.extend(admins.iter().map(evieverse_core::db::Value::from));
        values.extend([REFUSED_KIND, HELD_KIND, VIDEO_KIND].map(evieverse_core::db::Value::from));
        values.push(format!("{start}%").into());
        let already = db
            .fetch(&format!("SELECT user_id FROM inbox WHERE user_id IN ({}) AND kind IN (?, ?, ?) AND read_at IS NULL AND body LIKE ?", places(admins.len())), &values)
            .await?;
        let already = already.iter().map(|row| row.string("user_id")).collect::<anyhow::Result<Vec<_>>>()?;
        for admin in admins.iter().filter(|admin| !already.contains(admin)) {
            db.execute(
                "INSERT INTO inbox (id, user_id, kind, sender_id, content_id, tag, body, created_at, read_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, NULL)",
                params![uuid::Uuid::new_v4().to_string(), admin, kind, content_id.clone(), &body, now],
            )
            .await?;
        }
        anyhow::Ok(())
    };
    if let Err(err) = told.await {
        log.error(
            json!({ "err": log::err(&err), "match": as_json(&facts) }),
            &format!("pdq: {what} matches the list of hashes of known child sexual abuse material, and the admins couldn't be told in their inboxes"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_name_short_and_on_one_line() {
        assert_eq!(brief(Some("  a\r\n\tb\u{0}c  ")).as_deref(), Some("a b c"));
        assert_eq!(brief(Some("\n \t")), None);
        assert_eq!(brief(None), None);
        let long = "é".repeat(200);
        let cut = brief(Some(&long)).unwrap();
        assert_eq!(cut.chars().count(), 160);
        assert!(cut.ends_with('…'));
        assert_eq!(brief(Some(&"x".repeat(160))).unwrap().chars().count(), 160);
        assert_eq!(number(4.0).unwrap().to_string(), "4");
        assert_eq!(number(2.5).unwrap().to_string(), "2.5");
    }
}
