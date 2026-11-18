# Trust plugins

A trust plugin is an algorithm that looks at a post and may lower its trust score, which [decides where the post goes](API.md#moderation). Each folder of `src/plugins/trust` is one plugin, named after the folder. New posts and comments pass through all trust algorithms the server runs: every plugin installed, except the [optional ones](#optional-plugins) it didn't turn on. So does what a user puts on their [profile](#profiles): a bio, links and an avatar.

The base instance comes with three:

| Plugin | Runs | What it does |
| --- | --- | --- |
| `src/plugins/trust/blocked_words` | Always | Gives a post, a comment or a profile with a word or phrase on the server's list of blocked words a score of 0. |
| `src/plugins/trust/urlhaus` | Only if turned on: it's [optional](#optional-plugins) | Gives a post, a comment or a profile with a link on [URLhaus](https://urlhaus.abuse.ch)'s list of malware URLs a score of 0. See [Links that spread malware](#links-that-spread-malware). |
| `src/plugins/trust/pdq` | Only if turned on: it's [optional](#optional-plugins) | Gives a post or a comment with an image, or an avatar, whose [PDQ](https://github.com/facebook/ThreatExchange/tree/main/pdq) hash is on the server's list of hashes of known child sexual abuse material a score of 0, and tells the server's admins. See [Images of known child sexual abuse material](#images-of-known-child-sexual-abuse-material). |

To add one, add a folder with an `index.ts` whose default export has an `assess` function. Use the examples below to guide you. Then build and restart the server:

```ts
// src/plugins/trust/links/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.types.js';

export default {
  assess({ texts, commentOn, profile }) {
    if (profile) return; // a profile has up to 10 links of its own
    const links = texts.join(' ').match(/https?:\/\//g)?.length ?? 0;
    if (links <= 3) return;
    const what = commentOn ? 'comment' : 'post';
    return { reduce: 40, reason: `the ${what} has too many links, so it wasn't published` };
  },
} satisfies TrustAlgorithm;
```

```ts
// src/plugins/trust/new_accounts/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.types.js';

const DAY = 24 * 60 * 60 * 1000;

export default {
  async assess({ userId, commentOn, profile }, { db, config, now }) {
    if (commentOn || profile) return; // posts only
    const user = await db.selectFrom('users').select('created_at').where('id', '=', userId).executeTakeFirst();
    if (user && now() - user.created_at < DAY) return { set: config.trust.allowFrom - 1 };
  },
} satisfies TrustAlgorithm;
```

## Optional plugins

A plugin runs on every server that has its folder, unless it says it's optional. An optional plugin runs only on a server that names it in `TRUST_OPTIONAL_PLUGINS` ([configuration](CONFIG.md)), so a plugin can ship with the server, or with your fork, without every instance running it.

To make a plugin optional, add `optional: true` to what it exports:

```ts
// src/plugins/trust/new_accounts/index.ts
export default {
  optional: true,
  async assess({ userId, commentOn, profile }, { db, config, now }) {
    // ...
  },
} satisfies TrustAlgorithm;
```

To turn optional plugins on, name their folders, separated by commas or spaces, and restart the server:

```sh
TRUST_OPTIONAL_PLUGINS=urlhaus,new_accounts
```

- With `TRUST_OPTIONAL_PLUGINS` empty, which is the default, no optional plugin runs.
- A plugin that isn't optional runs whatever `TRUST_OPTIONAL_PLUGINS` says. Naming it there changes nothing.
- A name that isn't a folder of `src/plugins/trust` stops the server from starting, so a misspelt name can't leave a plugin off unnoticed.
- An optional plugin that is off is never called, but its folder is still loaded when the server starts, so it must still hold a plugin.
- The server logs the plugins it runs when it starts (`trust plugins loaded`).

## Profiles

What a user puts on their [profile](API.md#a-users-profile) is scored as a post is, by the same plugins, before it's saved: a bio and links when [`PATCH /users/:userId`](API.md#get-usersuserid-and-patch-usersuserid) sets them, and an avatar when [`PUT /users/:userId/avatar`](API.md#the-avatar) does. A plugin can tell it from a post by `profile`, which is `true` for it ([below](#parameters-of-assess)).

- **A profile has no moderation queue.** A score of `TRUST_SCORE_ALLOW_FROM` or more saves it, and anything less refuses it with `422`: what would hold a post refuses a profile, on a server that deletes nothing on arrival too.
- **Only what the request sets is scored.** A request that sets a bio is scored on the bio, not on the links and the avatar the user already has. Taking something away isn't scored.
- **The avatar is the image as the user sent it,** without its metadata. The server makes the avatar it stores of that image afterwards: a square of 400 pixels a side, as WebP.
- **A plugin written for posts sees profiles too.** One whose rule is about posts returns early for them, as the examples above do. A `reason` is sent as the plugin wrote it, so one that scores profiles gives them a reason that fits: the three plugins here say "so it wasn't saved" where a post's reason says "so it wasn't published".
- **A refusal with no `reason`** gets the general message, "this server doesn't trust this enough to show it on a profile, so it wasn't saved".

## Links that spread malware

`urlhaus` is one of the two optional plugins the server comes with. It checks every link of a post or a comment (a link post's URL, and the links written in a text, a caption or a comment) against the list of malware URLs that [URLhaus](https://urlhaus.abuse.ch) publishes, and gives a post with a listed link a score of 0. With the default thresholds that post is refused with `422`. A [profile](#profiles)'s links are checked the same way, with the links written in its bio.

To turn it on:

1. Get the Auth-Key of an abuse.ch account, which is free: [auth.abuse.ch](https://auth.abuse.ch).
2. Set `TRUST_OPTIONAL_PLUGINS=urlhaus` and `URLHAUS_AUTH_KEY` to the key. A server that names `urlhaus` without a key doesn't start.
3. Make sure the server can reach `urlhaus-api.abuse.ch` over HTTPS.

What to know about it:

- **The server never follows a link.** Each process downloads the list, keeps it in memory, and looks links up there, so checking a link takes no request. The list is downloaded again every `URLHAUS_REFRESH_MINUTES` (15), in the background.
- **When URLhaus can't be reached**, the list the process has stays in use. Only a process that never got a list refuses posts: one with an `http` or `https` link fails with `500` until a download succeeds, which is tried again every minute. Posts without links aren't affected.
- **What matches** is a listed URL, however it's written: with either scheme, with a query or a fragment added, or with more path after it. Other pages of the same host don't match, since URLhaus lists files on hosts that many people share.
- **What it doesn't catch:** a URL that URLhaus lists after the post was sent, a URL that redirects to a listed one, as a link shortener does, and what URLhaus doesn't collect, such as phishing pages.
- By default the list is the URLs added in the last 30 days (`URLHAUS_LIST_URL`).

## Images of known child sexual abuse material

`pdq` is the other optional plugin. It hashes every image of an image post, the image a comment comes with, and the image a user sends as their avatar, using [PDQ](https://github.com/facebook/ThreatExchange/tree/main/pdq): the perceptual hash Meta published for finding copies of a known picture, which stays nearly the same when the picture is resized, compressed again or lightly edited. It looks the hash up in a list of hashes of known child sexual abuse material. A post or a comment with an image that matches, or an avatar that does, gets a score of 0, and every admin of the server is told, with what a report to the authorities is written from.

To turn it on:

1. Get a list of PDQ hashes of this material. The server comes with none, and there is no public one: the hashes are shared with the platforms that apply for them by those who keep them (a hash-sharing programme, such as NCMEC's or Meta's ThreatExchange).
2. Set `TRUST_OPTIONAL_PLUGINS=pdq` and `PDQ_HASH_LIST` to where the list is: the path of a file, or an `http` or `https` address, with `PDQ_HASH_LIST_AUTHORIZATION` as its Authorization header if it asks for one. A server that names `pdq` without a list doesn't start, and neither does one with `TRUST_SCORE_ALLOW_FROM=0`, which would publish the image whatever its score.
3. Make sure the server has an admin who reads their inbox, since that is who is told.

What to know about it:

- **The server reports nothing itself,** and sends no image and no hash anywhere. It tells its admins, and reporting is the operator's to do, as the law where they operate asks: in the United States, a provider that knows of such material reports it to NCMEC's [CyberTipline](https://report.cybertip.org). A match is a strong sign, not proof. Nothing here is legal advice: check your own obligations.
- **How the admins are told.** Every admin gets a [notice](API.md#notices) in their inbox, `csam_match_refused`, and the log gets a warning. Both have who sent the image, when, from which address and with which User-Agent, whether it was a post, an update, a comment or an avatar, the image's filename, type and SHA-256, its PDQ hash, and the listed hash it matched. An admin with an unread notice of the same user and the same listed hash gets no second one, so sending an image over and over doesn't fill an inbox; the log has each time. Notices are deleted with the rest of the inbox after `INBOX_RETENTION_DAYS` (90), so copy what a report needs before then.
- **Whoever sent the image isn't told what was found.** With the default thresholds the post or comment is refused with `422` and the general message, "this server doesn't trust the post enough to keep it, so it wasn't published". An avatar is refused with the general message for a profile, "this server doesn't trust this enough to show it on a profile, so it wasn't saved".
- **The server keeps no copy of the image.** A refused post isn't stored, so what is left is the facts in the notice and the log. The one exception is an image sent with an [upload link](API.md#post-uploads): it stays among the uploads in the content store, as any refused post's does, until the content store expires it.
- **On a server that deletes nothing on arrival** (`TRUST_SCORE_DELETE_BELOW=0`), the post or comment is stored instead, and waits in the moderation queue with a score of 0, where server moderators and admins see it and could accept it. The notice is then `csam_match_held`, and says so. An avatar is refused there too, and nothing of it is stored: a profile has no queue to wait in, so its notice is always `csam_match_refused`.
- **The list** has one hash a line, as 64 hex digits. A CSV or TSV with the hash in a column is read too, and lines that start with `#` are skipped. A list of which fewer than half the hashes look like PDQ hashes is refused: that catches a list of SHA-256s, which are written the same way and would match nothing. Each process keeps the list in memory, about 100 bytes a hash, and reads it again every `PDQ_REFRESH_MINUTES` (60), in the background. A file that hasn't changed isn't read again.
- **When the list can't be read**, the list the process has stays in use. Only a process that never got a list refuses posts: a post or a comment with an image, or a new avatar, fails with `500` until a reading succeeds, which is tried again every minute. Posts without an image aren't affected.
- **What matches** is an image whose hash differs from a listed one in at most `PDQ_MAX_DISTANCE` (31) of its 256 bits, which is what PDQ's authors match at. An image with too little in it to tell it by, such as one of a single colour, isn't matched: its hash must have a quality of at least `PDQ_MIN_QUALITY` (50). Each frame of an animated GIF or WebP is checked as a picture of its own, up to the 32nd.
- **An image that can't be decoded** has no hash to check. It gets a score one under `TRUST_SCORE_ALLOW_FROM`, so it waits in the moderation queue for a person to look at. Where the two thresholds are the same and there is no queue, it's refused with "an image of the post couldn't be read to check it, so it wasn't published". An avatar that can't be decoded is refused on every server, with "the image couldn't be read to check it, so it wasn't saved".
- **What it doesn't catch:** a video or an audio file, an image that was mirrored, rotated or cropped far, the frames of an animation past the 32nd, an ad's image, an image whose hash is listed after it was sent, a repost of a post on another server, whose image this server never holds, and the image of a comment that is edited, since an edit keeps the file. Images stored before the plugin was turned on aren't looked at again.
- Images are decoded with the [`sharp`](https://sharp.pixelplumbing.com) package, which the server loads when the plugin reads its first image. A server that doesn't run the plugin loads it only to make an [avatar](API.md#the-avatar), when the first one is set.

## Parameters of `assess`

`assess(post, ctx)` is called with two objects. The examples above destructure the fields they need from each.

`post` is what is being assessed: a new post, an update of a post, a comment, or what a user puts on their [profile](#profiles).

| Field | Type | What it is |
| --- | --- | --- |
| `userId` | `string` | The id of the user who sent it: a post's publisher, a comment's author, or the user whose profile it is. |
| `contentId` | `string`, or absent | Only there for an update: the id of the post being updated. Absent for a new post, for a comment and for a profile. |
| `commentOn` | `string`, or absent | Only there for a comment: the id of the post the comment is on. Absent for a post and for a profile. |
| `profile` | `true`, or absent | Only there for a profile: a bio, links or an avatar, whichever the request sets. Absent for a post and for a comment, so with `commentOn` it tells the three apart. |
| `tags` | `string[]` | The hashtags the post was sent with, normalised, before moderation drops any. Always empty for a comment and for a profile. |
| `texts` | `string[]` | Everything there is to read. For a post: its text, caption or link, and its filename, or the filename of each image of an album, with each image's [alt text](API.md#alt-text). For a comment: its text, the name of its image or video, and its image's alt text. For a profile: the bio, each link, and the avatar's filename, whichever the request sets. Parts that are missing are left out. A text, a caption, a comment's text and a bio are as their readers read them: without their [formatting](TEXT_EDITORS.md), and with each link's address after its label, so `[here](https://example.com)` is `here https://example.com`. |
| `images` | `TrustImage[]`, or absent | The images of an image post, in their order, the one image a comment comes with, or the image a user sends as their avatar. Absent for anything else: a post of another type, a comment with a video or with no file, an edit of a comment (which keeps its file), a profile whose avatar isn't what's being set, and a repost of a post on another server. Each image has `mimeType`, `filename` (or `null`), `file()` and `sha256()`. `file()` resolves to the path of a temporary file that holds the image as it would be stored, without its metadata, and `sha256()` to that file's hash in hex. Nothing is read until a plugin asks, and an image sent with an upload link is fetched from the content store when it does. The file is the request's, which deletes it when it's over: read it, and neither change nor keep it. |

`ctx` is what the plugin has to work with.

| Field | Type | What it is |
| --- | --- | --- |
| `db` | `Db` | The server's database, as a [Kysely](https://kysely.dev) query builder. |
| `config` | `Config` | The server's [configuration](CONFIG.md). `config.trust.deleteBelow` and `config.trust.allowFrom` are the scores below which a post is refused, and from which it is published. |
| `now` | `() => number` | The current time in milliseconds. Call it instead of `Date.now()`. |
| `log` | `FastifyBaseLogger`, or absent | The log of the request that sent the post, for what the server's operator should know. Absent where a post is scored outside a request, so call it as `log?.warn(...)`. |
| `client` | `{ ip, userAgent }`, or absent | Who sent the request: its address as the server counts it (see `TRUST_PROXY` in the [configuration](CONFIG.md)), and its User-Agent header, or `null` if it sent none. Absent where a post is scored outside a request. |
| `score` | `number` | The score so far, from 0 to 100: 100 for the first plugin, then whatever the plugins before this one left. |

Things to consider:

- `reason` is optional. If the post is refused, the publisher gets the reason of the plugin that last lowered the score, or a general message if it gave none. So does the user whose [profile](#profiles) is refused. Words written here are sent as they are, in every language. To have a reason translated, add it to the [language files](LANGUAGES.md) and return its key instead: `reason: msg('moderation.blocked_word')`, with `msg` from `src/language.ts`.

- A folder without a plugin in it stops the server from starting, even if its plugin would be optional and off. A plugin that throws fails the post with `500`, and nothing is stored.

- A plugin that needs a setting of its own can read it from `config`, as `urlhaus` reads `config.urlhaus` and `pdq` reads `config.pdq`. Making the plugin optional keeps a server that hasn't set it from running the plugin.

Plugins are part of the server: they run with its access to the database and its configuration, so install only code you'd run as the server itself.