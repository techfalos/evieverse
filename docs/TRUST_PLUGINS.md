# Trust plugins

A trust plugin is an algorithm that looks at a post and may lower its trust score, which [decides where the post goes](API.md#moderation). Each folder of `compactor/crates/trust/src/plugins` is one plugin, named after the folder and written in Rust. New posts and comments pass through all trust algorithms the server runs: every plugin it was built with, except the [optional ones](#optional-plugins) it didn't turn on. So does what a user puts on their [profile](#profiles): a bio, links and an avatar.

The base instance comes with four:

| Plugin | Runs | What it does |
| --- | --- | --- |
| `blocked_words` | Always | Gives a post, a comment or a profile with a word or phrase on the server's list of blocked words a score of 0. |
| `urlhaus` | Only if turned on: it's [optional](#optional-plugins) | Gives a post, a comment or a profile with a link on [URLhaus](https://urlhaus.abuse.ch)'s list of malware URLs a score of 0. See [Links that spread malware](#links-that-spread-malware). |
| `pdq` | Only if turned on: it's [optional](#optional-plugins) | Gives a post or a comment with an image, or an avatar, whose [PDQ](https://github.com/facebook/ThreatExchange/tree/main/pdq) hash is on the server's list of hashes of known child sexual abuse material a score of 0, and tells the server's admins. Where the server processes videos, a video is checked against the same list before it's published, and where the server has a quarantine, the file that matched is kept there. See [Images of known child sexual abuse material](#images-of-known-child-sexual-abuse-material). |
| `synthid` | Only if turned on: it's [optional](#optional-plugins) | Gives a post or a comment with an image that carries a SynthID watermark, which says the image was made with AI, a score just under the one that publishes, so it waits for a moderator, or a score of 0 where the server says so. An avatar with one is refused. Each image is sent to a detector outside the server to be checked. See [Images made with AI](#images-made-with-ai). |

## Adding a plugin

To add one, add a folder with a `mod.rs` that has a `plugin()` function, which returns something that implements `TrustPlugin`. Its one required method is `assess`. Use the examples below to guide you.

```rust
// compactor/crates/trust/src/plugins/links/mod.rs
use anyhow::Result;
use async_trait::async_trait;

use crate::trust::{Reason, TrustChange, TrustContext, TrustPlugin, TrustPost};

struct Links;

#[async_trait]
impl TrustPlugin for Links {
    async fn assess(&self, post: &TrustPost, _ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        if post.profile {
            return Ok(None); // a profile has up to 10 links of its own
        }
        let links: usize = post.texts.iter().map(|text| text.matches("http://").count() + text.matches("https://").count()).sum();
        if links <= 3 {
            return Ok(None);
        }
        let what = if post.comment_on.is_some() { "comment" } else { "post" };
        let reason = Reason::Words(format!("the {what} has too many links, so it wasn't published"));
        Ok(Some(TrustChange::reduce(40).because(reason)))
    }
}

/// The plugin, as the registry asks for it.
pub fn plugin() -> Box<dyn TrustPlugin> {
    Box::new(Links)
}
```

```rust
// compactor/crates/trust/src/plugins/new_accounts/mod.rs
use anyhow::Result;
use async_trait::async_trait;
use evieverse_core::params;
use evieverse_core::time::DAY;

use crate::trust::{TrustChange, TrustContext, TrustPlugin, TrustPost};

struct NewAccounts;

#[async_trait]
impl TrustPlugin for NewAccounts {
    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        if post.comment_on.is_some() || post.profile {
            return Ok(None); // posts only
        }
        let Some(user) = ctx.db.fetch_optional("SELECT created_at FROM users WHERE id = ?", params![post.user_id.as_str()]).await? else {
            return Ok(None);
        };
        if (ctx.now)() - user.i64("created_at")? < DAY {
            return Ok(Some(TrustChange::set(ctx.config.trust.allow_from - 1)));
        }
        Ok(None)
    }
}

/// The plugin, as the registry asks for it.
pub fn plugin() -> Box<dyn TrustPlugin> {
    Box::new(NewAccounts)
}
```

What `assess` returns:

- `Ok(None)` leaves the score as it is.
- `Ok(Some(TrustChange::reduce(40)))` takes 40 off the score, and `Ok(Some(TrustChange::set(0)))` sets it. Either way a score only goes down, and never under 0: setting it higher than it is changes nothing.
- `.because(reason)` adds what the sender is told if this change is what has the post refused ([below](#things-to-consider)).
- An error fails the post with `500`, and nothing is stored.

Nothing else names the plugin. The build finds every folder of `plugins` and registers it under the folder's name, so there's no list to add it to. A folder's name is lowercase letters, digits and underscores, and doesn't start with a digit. A folder without a `mod.rs` fails the build.

### Building it

Plugins are compiled, into two things: the addon the API loads to score what it's sent, and the compactor, which scores a repost when its original on another server changes, and checks videos. Both get every plugin, so build both and restart both.

- From source: `npm run build:native`, then restart the server and the compactor. It needs Rust, which [rustup](https://rustup.rs) installs at the version `compactor/rust-toolchain.toml` pins.
- With Docker: build the image again, which compiles them (`docker compose -f docker-compose.server.yml up -d --build`). The [Terraform modules](IAC.md#deploying-a-change) build it again when a file under `compactor` has changed.

A plugin that needs a crate the others don't use adds it to `compactor/crates/trust/Cargo.toml`.

### Testing it

A plugin's tests go in its own file, in a `tests` module, and run with the crate's (`cd compactor && cargo test -p evieverse-trust`). `World` gives a test a database with the server's tables, the server's settings and a clock:

```rust
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::trust::Change;
    use crate::trust::tests::World;

    #[tokio::test]
    async fn a_post_with_many_links_loses_trust() {
        let world = World::new(json!({})).await;
        let post = TrustPost { user_id: "u1".into(), texts: vec!["http://a.example https://b.example http://c.example http://d.example".into()], ..TrustPost::default() };
        let change = plugin().assess(&post, &world.ctx()).await.unwrap();
        assert_eq!(change.map(|change| change.change), Some(Change::Reduce(40)));
    }
}
```

`World::new` takes settings as a [configuration file](CONFIG.md) has them, for a plugin that reads its own.

## Optional plugins

A plugin runs on every server that was built with it, unless it says it's optional. An optional plugin runs only on a server that names it in `TRUST_OPTIONAL_PLUGINS` ([configuration](CONFIG.md)), so a plugin can ship with the server, or with your fork, without every instance running it.

To make a plugin optional, have its `optional` return `true`:

```rust
// compactor/crates/trust/src/plugins/new_accounts/mod.rs
#[async_trait]
impl TrustPlugin for NewAccounts {
    fn optional(&self) -> bool {
        true
    }

    async fn assess(&self, post: &TrustPost, ctx: &TrustContext<'_>) -> Result<Option<TrustChange>> {
        // ...
    }
}
```

To turn optional plugins on, name their folders, separated by commas or spaces, and restart the server and the compactor:

```sh
TRUST_OPTIONAL_PLUGINS=urlhaus,new_accounts
```

- With `TRUST_OPTIONAL_PLUGINS` empty, which is the default, no optional plugin runs.
- A plugin that isn't optional runs whatever `TRUST_OPTIONAL_PLUGINS` says. Naming it there changes nothing.
- A name that isn't one of the plugins the server was built with stops the server from starting, and the compactor too, so a misspelt name can't leave a plugin off unnoticed. The error names the plugins there are.
- An optional plugin that is off is never called, but it's still compiled in, so it must still build.
- The compactor reads `TRUST_OPTIONAL_PLUGINS` for itself. Give it the same value as the server, or the two run different plugins.
- The server logs the plugins it runs when it starts (`trust plugins loaded`).

## Profiles

What a user puts on their [profile](API.md#a-users-profile) is scored as a post is, by the same plugins, before it's saved: a bio and links when [`PATCH /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid) sets them, and an avatar when [`PUT /users/:userId/avatar`](API.md#the-avatar) does. A plugin can tell it from a post by `profile`, which is `true` for it ([below](#parameters-of-assess)).

- A profile has no moderation queue. A score of `TRUST_SCORE_ALLOW_FROM` or more saves it, and anything less refuses it with `422`: what would hold a post refuses a profile, on a server that deletes nothing on arrival too.
- Only what the request sets is scored. A request that sets a bio is scored on the bio, not on the links and the avatar the user already has. Taking something away isn't scored.
- The avatar is the image as the user sent it, without its metadata. The server makes the avatar it stores of that image afterwards: a square of 400 pixels a side, as WebP.
- A plugin written for posts sees profiles too. One whose rule is about posts returns early for them, as the examples above do. A `reason` is sent as the plugin wrote it, so one that scores profiles gives them a reason that fits: the plugins here say "so it wasn't saved" where a post's reason says "so it wasn't published".
- A refusal with no `reason` gets the general message, "this server doesn't trust this enough to show it on a profile, so it wasn't saved".

## Links that spread malware

`urlhaus` is one of the three optional plugins the server comes with. It checks every link of a post or a comment (a link post's URL, and the links written in a text, a caption or a comment) against the list of malware URLs that [URLhaus](https://urlhaus.abuse.ch) publishes, and gives a post with a listed link a score of 0. With the default thresholds that post is refused with `422`. A [profile](#profiles)'s links are checked the same way, with the links written in its bio.

To turn it on:

1. Get the Auth-Key of an abuse.ch account, which is free: [auth.abuse.ch](https://auth.abuse.ch).
2. Set `TRUST_OPTIONAL_PLUGINS=urlhaus` and `URLHAUS_AUTH_KEY` to the key. A server that names `urlhaus` without a key doesn't start.
3. Make sure the server can reach `urlhaus-api.abuse.ch` over HTTPS.

What to know about it:

- The server never follows a link. Each process downloads the list, keeps it in memory, and looks links up there, so checking a link takes no request. The list is downloaded again every `URLHAUS_REFRESH_MINUTES` (15), in the background.
- When URLhaus can't be reached, the list the process has stays in use. Only a process that never got a list refuses posts: one with an `http` or `https` link fails with `500` until a download succeeds, which is tried again every minute. Posts without links aren't affected.
- What matches is a listed URL, however it's written: with either scheme, with a query or a fragment added, or with more path after it. Other pages of the same host don't match, since URLhaus lists files on hosts that many people share.
- What it doesn't catch: a URL that URLhaus lists after the post was sent, a URL that redirects to a listed one, as a link shortener does, and what URLhaus doesn't collect, such as phishing pages.
- By default the list is the URLs added in the last 30 days (`URLHAUS_LIST_URL`).

## Images of known child sexual abuse material

`pdq` is the second optional plugin. It hashes every image of an image post, the image a comment comes with, and the image a user sends as their avatar, using [PDQ](https://github.com/facebook/ThreatExchange/tree/main/pdq): the perceptual hash Meta published for finding copies of a known picture, which stays nearly the same when the picture is resized, compressed again or lightly edited. It looks the hash up in a list of hashes of known child sexual abuse material. A post or a comment with an image that matches, or an avatar that does, gets a score of 0, and every admin of the server is told, with what a report to the authorities is written from.

Two things go with it. Where the server processes videos, each video is checked against the same list before it's published ([Videos](#videos)). And where the server has a quarantine, which is off unless its operator sets one up, the file that matched is kept for the report and after it ([The quarantine](#the-quarantine)).

To turn it on:

1. Get a list of PDQ hashes of this material. The server comes with none, and there is no public one: the hashes are shared with the platforms that apply for them by those who keep them (a hash-sharing programme, such as NCMEC's or Meta's ThreatExchange).
2. Set `TRUST_OPTIONAL_PLUGINS=pdq` and `PDQ_HASH_LIST` to where the list is: the path of a file, or an `http` or `https` address, with `PDQ_HASH_LIST_AUTHORIZATION` as its Authorization header if it asks for one. A server that names `pdq` without a list doesn't start, and neither does one with `TRUST_SCORE_ALLOW_FROM=0`, which would publish the image whatever its score.
3. Make sure the server has an admin who reads their inbox, since that is who is told.
4. Decide whether the server keeps the files that match, and if it does, set `QUARANTINE_SCHEME` and `QUARANTINE_OPTIONS` to a store of its own ([The quarantine](#the-quarantine)). Without them nothing of a matched file is kept, so there is no file to send with a report or to preserve after it. The server says so in its log when it starts.
5. Give the process that runs the compactor the same `TRUST_OPTIONAL_PLUGINS`, `PDQ_` and `QUARANTINE_` settings as the processes that serve the API: it's the one that checks videos, and the one that deletes quarantined files when their time is over.

What to know about it:

- The server reports nothing itself, and sends no image and no hash anywhere. It tells its admins, and reporting is the operator's to do, as the law where they operate asks: in the United States, a provider that knows of such material reports it to NCMEC's [CyberTipline](https://report.cybertip.org). A match is a strong sign, not proof. Nothing here is legal advice: check your own obligations.
- How the admins are told. Every admin gets a [notice](API.md#notices) in their inbox, `csam_match_refused`, and the log gets a warning. Both have who sent the image, when, from which address and with which User-Agent, whether it was a post, an update, a comment or an avatar, the image's filename, type and SHA-256, its PDQ hash, and the listed hash it matched. An admin with an unread notice of the same user and the same listed hash gets no second one, so sending an image over and over doesn't fill an inbox; the log has each time. A video's notice is `csam_video_refused` ([Videos](#videos)). On a server with a quarantine, the notice also names the item the file is kept as (`quarantineId`), and says how to read the file and how to record the report. Notices are deleted with the rest of the inbox after `INBOX_RETENTION_DAYS` (90), so copy what a report needs before then; a quarantined item keeps the same facts for as long as it's kept.
- Whoever sent the image isn't told what was found. With the default thresholds the post or comment is refused with `422` and the general message, "this server doesn't trust the post enough to keep it, so it wasn't published". An avatar is refused with the general message for a profile, "this server doesn't trust this enough to show it on a profile, so it wasn't saved".
- Without a quarantine, the server keeps no copy of the image. A refused post isn't stored, so what is left is the facts in the notice and the log. The one exception is an image sent with an [upload link](API.md#post-uploads): it stays among the uploads in the content store, as any refused post's does, until the content store expires it. With a [quarantine](#the-quarantine), the file is kept there, and nowhere among the posts.
- On a server that deletes nothing on arrival (`TRUST_SCORE_DELETE_BELOW=0`), the post or comment is stored instead, and waits in the moderation queue with a score of 0, where server moderators and admins see it and could accept it. The notice is then `csam_match_held`, and says so. An avatar is refused there too, and nothing of it is stored: a profile has no queue to wait in, so its notice is always `csam_match_refused`.
- The list has one hash a line, as 64 hex digits. A CSV or TSV with the hash in a column is read too, and lines that start with `#` are skipped. A list of which fewer than half the hashes look like PDQ hashes is refused: that catches a list of SHA-256s, which are written the same way and would match nothing. Each process keeps the list in memory, about 100 bytes a hash, and reads it again every `PDQ_REFRESH_MINUTES` (60), in the background. A file that hasn't changed isn't read again.
- When the list can't be read, the list the process has stays in use. Only a process that never got a list refuses posts: a post or a comment with an image, or a new avatar, fails with `500` until a reading succeeds, which is tried again every minute. Posts without an image aren't affected.
- What matches is an image whose hash differs from a listed one in at most `PDQ_MAX_DISTANCE` (31) of its 256 bits, which is what PDQ's authors match at. An image with too little in it to tell it by, such as one of a single colour, isn't matched: its hash must have a quality of at least `PDQ_MIN_QUALITY` (50). Each frame of an animated GIF or WebP is checked as a picture of its own, up to the 32nd.
- An image that can't be decoded has no hash to check. It gets a score one under `TRUST_SCORE_ALLOW_FROM`, so it waits in the moderation queue for a person to look at. Where the two thresholds are the same and there is no queue, it's refused with "an image of the post couldn't be read to check it, so it wasn't published". An avatar that can't be decoded is refused on every server, with "the image couldn't be read to check it, so it wasn't saved".
- What it doesn't catch: an audio file, a video on a server that doesn't process videos (`VIDEO_PROCESSING=false`), what a video shows for less than two seconds between two of the pictures that are checked, an image or a video that was mirrored, rotated or cropped far, the frames of an animation past the 32nd, an ad's image, an image whose hash is listed after it was sent, a repost of a post on another server, whose image this server never holds, and the image of a comment that is edited, since an edit keeps the file. Images stored before the plugin was turned on aren't looked at again.
- Images are decoded by the [`image`](https://crates.io/crates/image) crate, in the server's own process and off the threads that answer requests. It reads a picture's pixels as they are stored, without applying a colour profile the file carries, and refuses one that would take more than 1 GB of memory to decode, which then counts as an image that can't be decoded.

### Videos

A video has no picture to hash until it's decoded, so it isn't checked when it's sent, and not by the plugin's `assess`. The video worker checks it, in the process that runs the compactor, on a server that [processes videos](API.md#videos) (`VIDEO_PROCESSING=true`, which is the default) and runs `pdq`.

- What is checked is one picture of the video every two seconds, each hashed and looked up as an image is, with the same `PDQ_MAX_DISTANCE` and `PDQ_MIN_QUALITY`. This follows Meta's vPDQ, which matches a video by the PDQ hashes of its frames; the server hashes fewer of them.
- It's checked before anything of it is published: once the server has made the video's largest size, and before any of it is written where posts are kept. The post or comment says `processing: true` until then, as any video's does.
- A video that matches is refused, whatever the thresholds are. A new post is deleted, an update leaves the post the video it had and makes the rest of what it said, and a comment isn't published at all, its text neither. It never waits in the moderation queue.
- Whoever sent it is told only that the video wasn't trusted, by a [notice](API.md#notices): `video_refused`, `video_update_refused` or `comment_video_refused`. The request that sent it was answered before the video was checked, so it was accepted.
- The admins are told as they are of an image, with the notice `csam_video_refused`. It has the facts an image's has, with `media: "video"`, how many `seconds` into the video the picture is, and the SHA-256 of the file as it was sent. The address and User-Agent are those of the request that sent the video: they're kept with the video while it waits, on a server that checks videos only, and deleted once it's processed.
- The file that is kept in the [quarantine](#the-quarantine), where there is one, is the video as it was sent.
- When the list can't be read, the list the process has stays in use. A process that never got one publishes nothing unchecked: the video waits, and is tried again every 15 seconds, without that counting against it.
- The compactor's process reads the list itself, from where `PDQ_HASH_LIST` says. If it's left without `TRUST_OPTIONAL_PLUGINS=pdq`, no video is checked, whatever the API's processes are set to.
- On a server that doesn't process videos, they're published as they're sent, and none is checked. The server says so in its log when it starts with `pdq` on, video posts on and `VIDEO_PROCESSING=false`.
- Videos stored before the plugin was turned on aren't looked at again.

### The quarantine

A provider that reports this material has to be able to send the file with its report, and may have to preserve it afterwards: in the United States, a report to the CyberTipline is a request to preserve what was reported for a year (18 U.S.C. 2258A(h)). A server that refuses a file and keeps nothing of it can do neither. The quarantine is where the server keeps the files that matched, and it's off unless its operator sets it up. Other countries ask for other things, and some for deletion: nothing here is legal advice, so check what the law where you operate asks of you.

To turn it on, set `QUARANTINE_SCHEME` and `QUARANTINE_OPTIONS` ([configuration](CONFIG.md#quarantine)) to a store that nothing else uses, written as the content store's settings are. The server doesn't start if they name the store of the posts, the summaries or the audit log.

- What is kept is the file that matched, before the post is refused or held: an image as the server read it, which is without the metadata its file came with, and a video as it was sent. The same file from the same user is kept once, and counted each time it's sent again. The item keeps the facts the admins were told, so they outlast the notice.
- Only admins read it, with the [quarantine endpoints](API.md#the-quarantine): the list of items, one item, its file, recording the report, and deleting one. Server moderators get `403`, and whoever sent the file is never told there is one. No link to a file is ever made: the bytes come through the server, as a file to save, which a browser doesn't show.
- Everything done with a file is recorded, in the database: that it was kept, each time an admin read it, each report recorded, and its deletion, with the admin, their address and their User-Agent. A reading is recorded before a byte is sent, and the record stays after the file is gone.
- The server learns of a report only when an admin records it (`POST /moderation/quarantine/:quarantineId/report`), with the report's id and when it was made. The compactor deletes the file `QUARANTINE_RETENTION_DAYS` (365) after that time, in its first run of a day. Raising the setting keeps the files there are for longer too. A file with a report recorded can't be deleted by hand.
- A file nobody reported is never deleted by the server, which would otherwise delete what the operator still has to report. The log says once a day how many wait. An admin who finds that a file isn't what the list took it for deletes it (`DELETE /moderation/quarantine/:quarantineId`), which is recorded too.
- Locking the store down is the operator's to do, and the server can't check it: a bucket of its own that is private and encrypted, with its access logged, that only the server's own roles can reach. The processes that serve the API write and read it, and the one that runs the compactor writes a video's file and deletes. Give it no lifecycle rule that deletes: the server deletes what is due, and a rule would delete what isn't.
- A file that can't be kept (a store that can't be reached, say) is logged as an error. The post is refused and the admins are told all the same, by a notice with no `quarantineId`.
- An item outlives the account that sent the file, and is no part of that user's [export](API.md#get-usersuseridexport).

## Images made with AI

`synthid` is the third optional plugin. It checks every image of an image post, the image a comment comes with, and the image a user sends as their avatar for a SynthID watermark: the mark some generators of images put in what they make, which can't be seen, is part of the picture and not of the file's metadata, and stays through most edits. A post or a comment with an image that carries one waits for a moderator, or is refused where the server says so, and an avatar that carries one is refused.

The server can't read the watermark itself, so it sends each image to a detector that can: by default OpenAI's [Content Provenance API](https://developers.openai.com/api/docs/guides/content-provenance). That one finds the watermarks of images made with OpenAI's models, and of no other maker's. Google, whose watermark SynthID is, has no detector a server can ask.

To turn it on:

1. Get an API key for the detector: for the default one, an OpenAI API key whose account has access to the Content Provenance API.
2. Set `TRUST_OPTIONAL_PLUGINS=synthid` and `SYNTHID_API_KEY` to the key. A server that names `synthid` without a key doesn't start.
3. Make sure the server can reach the detector over HTTPS: `api.openai.com`, unless `SYNTHID_URL` names another.
4. Say so where your users are told what becomes of what they send: their images go to the detector.

What to know about it:

- What is sent is the image as the server would store it, which is without its metadata, in a form, with the key as a Bearer token. The file is named after its type (`image.png`), not as its sender named it, and nothing else of the post goes with it: not its text, and not who sent it. A redirect isn't followed, so an image goes to the address you named and no further.
- What a watermark leads to is yours to say, with `SYNTHID_ACTION`. `hold`, which is the default, gives a score one under `TRUST_SCORE_ALLOW_FROM`: the post or comment is stored and waits in the moderation queue for a person to look at (`202`), or is refused where the two thresholds are the same and there is no queue. `refuse` gives a score of 0, which the default thresholds refuse with `422`. An avatar is refused either way, since a profile has no queue to wait in.
- A watermark isn't proof, and neither is an image without one. That is why the default holds: the detector's makers ask that what is decided by its answer be looked at by a person.
- Whoever sent the image is told why where it's refused: "an image of the post carries a watermark that says it was made with AI, so it wasn't published", for a comment "the comment's image carries a watermark that says it was made with AI, so it wasn't published", and for an avatar "the image carries a watermark that says it was made with AI, so it wasn't saved". The log has each watermark that was found, with the user, the image's name, type and SHA-256, and the model and time the detector gave, if it gave any. The admins get no notice.
- An image the detector couldn't check is yours to say too, with `SYNTHID_UNCHECKED`: the detector couldn't be reached, took more than 15 seconds, refused the key, took no more requests, or didn't read the file. `hold`, the default, holds it as a watermark is held, whatever `SYNTHID_ACTION` says, so that no image is published unchecked. Where that refuses it, the reason is "an image of the post couldn't be checked for a watermark that says it was made with AI, so it wasn't published", with "the comment's image…" for a comment, and for an avatar "the image couldn't be checked for a watermark that says it was made with AI, so it wasn't saved". `allow` lets it through as an image without a watermark.
- So with the defaults, while the detector is down or refuses the key, every image post and every comment with an image waits for a moderator, and no avatar can be set. The log has each image that wasn't checked, with the detector's status: as an error, or as a warning where the detector took no more requests. The key is in none of it. Unlike `urlhaus` and `pdq` without a list, the plugin doesn't fail a post with `500`.
- The request that sent the image waits for the detector: up to 15 seconds an image. The images of an album are asked about four at a time, in their order, and the first watermark is the answer. An image isn't asked about a second time when the detector fails, and nothing is kept between two posts: the same image sent twice is asked about twice.
- OpenAI limits how often this API is asked, and strictly. On a server with many image posts, count on images it couldn't check, and decide what `SYNTHID_UNCHECKED` should do with them.
- What a sender declares of their own post ([`aiGenerated`](API.md#post-store)) changes nothing, unless you say it does, with `SYNTHID_ALLOW_DISCLOSED=true`: by default a watermark counts the same on a post declared as created with AI as on one that isn't. With it on, a post or a comment declared as created with AI is left as it is: the plugin lowers no score for it, whatever its images carry, and sends none of them to the detector, which would find out nothing the sender didn't say. What is held or refused is then an image with a watermark that comes without the declaration. What the server says of generative AI (`GEN_AI`) changes nothing either way.
- With `SYNTHID_ALLOW_DISCLOSED=true`, an update that takes a post's declaration back is checked as a post without one is. A comment isn't: an edit keeps the comment's file, which isn't checked again, so a comment declared when it was sent stays unchecked if its author takes the declaration back. An avatar comes with no declaration, and is checked either way.
- What it doesn't catch: an image made by a generator that leaves no SynthID watermark, or whose watermark the detector doesn't read, which with the default detector is every maker's but OpenAI's; an image whose watermark was worn away; text, a video and an audio file; an ad's image; a repost of a post on another server, whose image this server never holds; and the image of a comment that is edited, since an edit keeps the file. Images stored before the plugin was turned on aren't looked at again.
- Another detector can stand in for the default one (`SYNTHID_URL`), if it takes the same request and answers as OpenAI's does: a `POST` whose form has the image as its `file`, answered with `{"results":[{"type":"synthid","outcome":"detected"}]}`, or `"not_detected"`. Any other answer counts as an image that couldn't be checked.
- The process that runs the compactor sends no image: what it scores has none. It takes the same `TRUST_OPTIONAL_PLUGINS` as the server, though, and so needs `SYNTHID_API_KEY` to start.

## Parameters of `assess`

`assess(&self, post, ctx)` is called with two structs, both of `crate::trust`.

`post` (`&TrustPost`) is what is being assessed: a new post, an update of a post, a comment, or what a user puts on their [profile](#profiles).

| Field | Type | What it is |
| --- | --- | --- |
| `user_id` | `String` | The id of the user who sent it: a post's publisher, a comment's author, or the user whose profile it is. |
| `content_id` | `Option<String>` | Only there for an update: the id of the post being updated. `None` for a new post, for a comment and for a profile. |
| `comment_on` | `Option<String>` | Only there for a comment: the id of the post the comment is on. `None` for a post and for a profile. |
| `profile` | `bool` | `true` only for a profile: a bio, links or an avatar, whichever the request sets. `false` for a post and for a comment, so with `comment_on` it tells the three apart. |
| `ai_generated` | `bool` | `true` for a post or a comment that is declared as created with AI ([`aiGenerated`](API.md#post-store)): by whoever sent it, an update's being the declaration the post will have, and for a repost of a post on another server, by the original's publisher. It's what was said, and nothing checked it. Always `false` for a profile. |
| `tags` | `Vec<String>` | The hashtags the post was sent with, normalised, before moderation drops any. Always empty for a comment and for a profile. |
| `texts` | `Vec<String>` | Everything there is to read. For a post: its text, caption or link, and its filename, or the filename of each image of an album, with each image's [alt text](API.md#alt-text). For a comment: its text, the name of its image or video, and its image's alt text. For a profile: the bio, each link, and the avatar's filename, whichever the request sets. Parts that are missing are left out. A text, a caption, a comment's text and a bio are as their readers read them: without their [formatting](TEXT_EDITORS.md), and with each link's address after its label, so `[here](https://example.com)` is `here https://example.com`. |
| `images` | `Vec<TrustImage>` | The images of an image post, in their order, the one image a comment comes with, or the image a user sends as their avatar. Empty for anything else: a post of another type, a comment with a video or with no file, an edit of a comment (which keeps its file), a profile whose avatar isn't what's being set, and a repost of a post on another server. Also empty on a server none of whose plugins [reads images](#plugins-that-read-images). |

Each `TrustImage` has:

| Field | Type | What it is |
| --- | --- | --- |
| `mime_type` | `String` | Which image its bytes are: `image/jpeg`, `image/png`, `image/gif` or `image/webp`, read from the bytes themselves. |
| `filename` | `Option<String>` | The name it was sent with, if it had one. |
| `file` | `PathBuf` | The path of a temporary file that holds the image as it would be stored, without its metadata. The file is the request's, which deletes it when it's over: read it, and neither change nor keep it. |
| `sha256` | `String` | That file's SHA-256, in hex. |

`ctx` (`&TrustContext`) is what the plugin has to work with.

| Field | Type | What it is |
| --- | --- | --- |
| `db` | `&Db` | The server's database, of the `evieverse-core` crate. It takes SQL with `?` for each value, on SQLite, Postgres and MySQL alike, and the values from `params![...]`: `fetch` returns the rows, `fetch_optional` the first if there is one, and `execute` how many rows a statement changed. A row gives a column by its name: `row.i64("created_at")?`, `row.string("username")?`, and `opt_i64` and `opt_string` for one that may be null. |
| `config` | `&Config` | The server's [configuration](CONFIG.md). `config.trust.delete_below` and `config.trust.allow_from` are the scores below which a post is refused, and from which it is published. |
| `now` | `&Clock` | The current time in milliseconds, as a function: call it as `(ctx.now)()`, instead of reading the system's clock, so that a test can set the time. |
| `log` | `&Logger` | The log of the request that sent the post, for what the server's operator should know: `ctx.log.warn(json!({ "userId": post.user_id }), "what happened")`. Where a post is scored outside a request, it's the log of the process. |
| `process_log` | `&Logger` | The log of the process, for what goes on after the request is answered, such as a list that is downloaded in the background. |
| `client` | `Option<&TrustClient>` | Who sent the request: `ip`, its address as the server counts it (see `TRUST_PROXY` in the [configuration](CONFIG.md)), and `user_agent`, its User-Agent header, or `None` if it sent none. `None` where a post is scored outside a request, as the compactor scores a repost. |
| `score` | `i64` | The score so far, from 0 to 100: 100 for the first plugin, then whatever the plugins before this one left. Plugins run in the order of their folders' names. |

### Plugins that read images

A plugin that looks at `post.images` says so, by having `reads_images` return `true`:

```rust
fn reads_images(&self) -> bool {
    true
}
```

Where none of the plugins a server runs says so, `images` is always empty and nothing of an image is read for them: one sent with an upload link stays in the content store, and is never fetched. Where one does, each image is written to a temporary file before the plugins run, and one sent with an upload link is fetched from the content store for it.

Decoding a picture takes long enough to hold up everything else the process is doing, so do it off the threads that answer requests, with `tokio::task::spawn_blocking`, as `pdq` does.

## Things to consider

- A reason is optional. If the post is refused, the publisher gets the reason of the plugin that last lowered the score, or a general message if it gave none. So does the user whose [profile](#profiles) is refused. Words written as `Reason::Words(...)` are sent as they are, in every language. To have a reason translated, add it to the [language files](LANGUAGES.md) and give its key instead: `.because(msg("moderation.blocked_word"))`, with `msg` from `crate::trust`.

- A plugin that returns an error fails the post with `500`, and nothing is stored. So does one that reduces a score by less than 0.

- A plugin that needs a setting of its own reads it from `ctx.config`, as `urlhaus` reads `config.urlhaus` and `pdq` reads `config.pdq`. A new setting is added in two places, since the API and the Rust code each read the configuration: `src/config.ts` and `compactor/crates/core/src/config.rs`. `test/config.test.ts` checks that the two agree. Making the plugin optional keeps a server that hasn't set it from running the plugin.

- A plugin runs in more than one process: in each process that serves the API, and in the compactor. What it keeps in memory, such as a list it downloads, each of them keeps for itself.

- The build refuses `unsafe` code (`unsafe_code = "deny"` in `compactor/Cargo.toml`), so a plugin has none.

Plugins are part of the server: they run with its access to the database and its configuration, so install only code you'd run as the server itself.
