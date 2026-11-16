# Evieverse API reference

Every Evieverse instance serves the same HTTP API. Clients, the [CLI](CLI.md) and `curl` all use it. This reference says what each endpoint takes and returns.

- [README.md](../README.md) introduces the project and how to run an instance.
- [APP.md](APP.md#6-request-flows) explains what the server does with each request, and why.

Names in capitals, such as `FEED_PAGE_SIZE`, are an instance's settings ([`.env.example`](../.env.example)). The values given with them are the defaults, which an instance may have changed.

## Endpoints

"Anyone" needs no key. "Any user" is any account, with its key ([authentication](#authentication)).

| Endpoint | Who can call it | What it does |
| --- | --- | --- |
| [`POST /register`](#post-register) | Anyone | Creates an account and returns its API key, once a [challenge](#challenges) is solved. An admin's request needs none. |
| [`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid) | Anyone | A user's public profile and roles. |
| [`PATCH /users/:userId`](#get-usersuserid-and-patch-usersuserid) | The user | Changes the user's username, their language, whether they take part in messages between users, or whether they show whom they follow and who follows them. |
| [`POST /users/:userId/key`](#post-usersuseridkey) | The user, or an admin | Replaces the user's API key with a new one, and revokes the old one. |
| [`DELETE /users/:userId`](#delete-usersuserid) | The user, or an admin | Deletes an account, and the posts it published. |
| [`GET /whoami`](#get-whoami) | Any user | The account a key belongs to, its roles, whether it's banned, its language and its settings. |
| [`GET /languages`](#get-languages) | Anyone | The languages the instance answers in. |
| [`POST /store`](#post-store) | Any user | Creates a post, or updates one of the user's own. |
| [`POST /uploads`](#post-uploads) | Any user | Gives a link for sending a large file straight to the content store. |
| [`GET /content/:contentId`](#get-contentcontentid) | Anyone | A post: its credit, text, hashtags and likes. |
| [`GET /content/:contentId/raw`](#get-contentcontentid) | Anyone | A post's bytes. |
| [`DELETE /content/:contentId`](#delete-contentcontentid) | The publisher, or an admin | Deletes a post. |
| [`POST /like`](#post-like) | Any user | Likes a post. |
| [`POST /report`](#post-report) | Any user | Reports a post, or a comment on one, to the server's moderators. |
| [`GET /content/:contentId/comments`](#reading-comments) | Anyone | A post's comments, a page at a time. |
| [`GET /content/:contentId/comments/:commentId`](#reading-comments) | Anyone | One comment. |
| [`POST /content/:contentId/comments`](#post-contentcontentidcomments) | Any user | Comments on a post that takes comments. |
| [`DELETE /content/:contentId/comments/:commentId`](#delete-contentcontentidcommentscommentid) | The comment's author, the post's publisher, or an admin | Deletes a comment. |
| [`PUT /users/:userId/following/:followeeId`](#following) | The user | Follows a user. |
| [`DELETE /users/:userId/following/:followeeId`](#following) | The user | Stops following a user. |
| [`GET /users/:userId/following`](#following) | The user, or anyone if the user shows the list | Lists whom a user follows. |
| [`GET /users/:userId/followers`](#following) | The user, or anyone if the user shows the list | Lists who follows a user. |
| [`GET /users/:userId/inbox`](#reading-the-inbox) | The user | The user's inbox: the messages users sent them, and the server's notices about their posts and mutes. |
| [`POST /users/:userId/inbox/read`](#reading-the-inbox) | The user | Marks what's in the inbox as read. |
| [`DELETE /users/:userId/inbox/:messageId`](#reading-the-inbox) | The user | Deletes a message or a notice from the inbox. |
| [`POST /messages`](#post-messages) | Any user | Sends another user a message. |
| [`PUT /users/:userId/blocked/:blockedId`](#blocks) | The user | Blocks a user: no message goes between the two. |
| [`DELETE /users/:userId/blocked/:blockedId`](#blocks) | The user | Ends a block. |
| [`GET /users/:userId/blocked`](#blocks) | The user | Lists whom the user blocks. |
| [`GET /feed`](#get-feed) | Anyone | A feed of one or more hashtags. |
| [`GET /feed/following`](#get-feedfollowing) | The user, or anyone if the user shows whom they follow | The posts of the users a user follows. |
| [`GET /tagging`](#get-tagging) | Anyone | Which hashtags a post can have: any, or the ones the instance lists. |
| [`GET /tags`](#get-tags) | Anyone | Lists the hashtags posts have used, most recently active first. |
| [`GET /rules`](#get-rules) | Anyone | The server's rules, and its modification disclosure: whether it runs a release of Evieverse or a modified version. |
| [`POST /rules`](#keeping-the-rules) | Admins | Adds a rule. |
| [`PATCH /rules/:ruleId`](#keeping-the-rules) | Admins | Changes a rule's text, or its place among the others. |
| [`DELETE /rules/:ruleId`](#keeping-the-rules) | Admins | Removes a rule. |
| [The moderation endpoints](#moderation-endpoints) | Mostly admins and moderators | Roles, bans, blocked words, mutes, the two kinds of moderation queue, and the report queue. |
| [`GET /cli` and the files under it](#the-cli-download) | Anyone | The CLI the instance ships. |
| `GET /health` | Anyone | `{ "ok": true }`, for a load balancer to check. |

## Conventions

- **Base URL.** An instance's own address, such as `https://api.example.com`. The examples here use `localhost:3000`, where a server run from this repo listens.
- **Bodies.** Requests and responses are JSON. The exceptions are files: `POST /store` also takes `multipart/form-data`, and `GET /content/:contentId/raw` returns a post's bytes.
- **Time.** Every timestamp is UTC, as ISO-8601 with a `Z` suffix: `2026-11-10T14:02:00.000Z`.
- **Ids.** Users, content and comments are identified by UUIDs.
- **Pages.** An endpoint that returns a page at a time gives a `nextCursor` with it. Send that as `cursor` to get the next page. It's `null` when there are no more.

### Authentication

Write endpoints authenticate with `userId` and `apiKey`, which [`POST /register`](#post-register) returns. Send them in the JSON body or form fields, or as the headers `Authorization: Bearer <apiKey>` and `X-User-Id: <userId>`. A missing or wrong key gets `401`. Reading hashtag feeds, content, profiles and hashtags needs no key, and neither does a [follow list](#following) or a [following feed](#get-feedfollowing) whose user shows whom they follow. A `GET` has no body, so one that needs a key takes it from the headers.

```bash
curl localhost:3000/whoami -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

An account has one key at a time: the one it was registered with, until its owner or an admin replaces it ([`POST /users/:userId/key`](#post-usersuseridkey)), which revokes the old key.

### Errors

Errors are JSON, `{ error, details? }`. A request that doesn't validate gets `400`, with what was wrong in `details`. Anything unexpected gets `500`.

| Status | What it means |
| --- | --- |
| `400` | The request isn't valid. |
| `401` | The `userId` and `apiKey` are missing or wrong. |
| `403` | The key is right, but its account may not do this: it doesn't own what it's changing, or doesn't have the role. Also a [follow list](#following) or a [following feed](#get-feedfollowing) its user doesn't show, asked for by anyone else, with a key or without. |
| `404` | There's no such user, content or comment. Content set for deletion, or held in the [moderation queue](#the-moderation-queue), counts as not there, and so do the comments of a post that doesn't take them. |
| `409` | The request conflicts with what's there: a username that's taken, an update of content set for deletion, a follow past the limit. |
| `410` | A feed's cursor was issued by an earlier release of the server: start the feed over. |
| `413` | The file is larger than the instance accepts. |
| `422` | [Moderation](#moderation) refused the post, or the comment. |
| `426` | For the CLI only: the instance ships another build of it ([CLI.md](CLI.md#updates)). |
| `428` | The request needs a [challenge](#challenges) solved. |
| `429` | Too many requests: registrations from one address, posts in a minute, upload links in a minute, messages in a minute, comments in a minute, or reports in an hour. |
| `501` | The instance's content store can't sign upload links ([`POST /uploads`](#post-uploads)). |
| `503` | An unfollow was made, but the following feed couldn't be updated: send it again. |

### Languages

What the instance says, which is the `error` of an error response and the `note` that comes with a new key, is in one of its languages. Posts aren't: they stay as their publishers wrote them. Machine-readable values, such as a `status`, are the same in every language, so a client should go by the status code and those, never by the wording of an `error`.

The language of a response is:
1. **The user's**, on a request that carries a valid `userId` and `apiKey`. That's the one they [registered in](#post-register) or [changed to](#get-usersuserid-and-patch-usersuserid) since, whatever the request's headers say.
2. Otherwise **the one the `Accept-Language` header asks for**, the most wanted of those the instance has. A regional variant is answered in the closest one there is: `es-MX` in `es`, and `pt` in `pt-BR`.
3. Otherwise **the instance's default** (`DEFAULT_LANGUAGE`, `en`).

A language that lacks a message says it in the default language. Two things are in English in every language: what `details` says about each field of a request that doesn't validate, and the errors of requests that never reach a route (a body that isn't JSON, a path that isn't there).

#### `GET /languages`

Lists the instance's languages, in the order of their codes, and which is the default:

```json
{ "default": "en",
  "languages": [{ "code": "en", "name": "English" }, { "code": "es", "name": "Español" }] }
```

`code` is what `POST /register` and `PATCH /users/:userId` take as `language`, in any case. `name` is the language's name in the language itself, for a client to show in a list. An instance has one language per file of its `src/languages` folder, so [adding a file](LANGUAGES.md) adds a language.

## Challenges

To keep robots out, two kinds of request must show that a person is behind them by solving challenges: registering (unless an admin does it), and posting less than a minute (`CHALLENGE_POST_WINDOW_SECONDS`) after your previous post or challenge. Such a request is answered with `428`, and nothing is done. The response holds the challenge:

```json
{ "error": "solve the challenge to register",
  "challenge": { "id": "8f0c2d1e-…", "image": "data:image/png;base64,iVBORw0KGgo…",
                 "expiresAt": "2026-11-10T14:02:00.000Z", "expiresInSeconds": 120,
                 "step": 1, "steps": 1,
                 "proofOfWork": { "algorithm": "SHA-256", "prefix": "8f0c2d1e-…:", "bits": 18 } } }
```

To solve it, send the same request again within 120 seconds (`CHALLENGE_TTL_SECONDS`), with three more fields:
- `challengeId`: the challenge's `id`.
- `challengeAnswer`: the six characters in the image, typed by a person. Case and spaces don't matter.
- `challengeNonce`: the proof of work, which the client's software finds while the person reads. It's any string that makes the SHA-256 of `prefix + nonce` (UTF-8) start with `bits` zero bits. Counting up from 0 finds one after about 2^`bits` hashes on average: at 18 bits, about 1.5 seconds in a desktop browser, and longer on slower devices.

Rules:
- **One answer per challenge.** Each challenge can be answered once, right or wrong. A wrong, late or incomplete answer gets `428` again, with a new challenge and an `error` that says what was wrong.
- **Not too fast.** An answer sent less than `CHALLENGE_MIN_SOLVE_MS` (2 seconds) after the challenge was issued is refused, since no person reads and types it that fast.
- **Only for its own request.** A challenge works only for what it was issued for: registering, or the posts of the user it was issued to.
- **None for an admin who registers a user.** A registration sent with an admin's credentials goes through without one ([`POST /register`](#post-register)). An admin's own posts get challenges like anyone's.
- **Posts in a row cost more, up to two challenges.** Registering takes one challenge. A post takes one or two, depending on how long you've kept posting without a break:
  - The first post in a run (less than a minute after your previous post) needs one challenge, and so does the second. Every post after that needs two, and no post ever needs more.
  - Two are solved one after another. `step` and `steps` say where you are: the first right answer is answered with `428` again and the second challenge, and the second lets the post through. A wrong answer gets a new challenge at the same step.
  - Every challenge starts the minute again, so the run only ends when a minute goes by without a post or a challenge. The next post then needs none, and the run starts over.

  That's aimed at robots that have their challenges solved by paid people or a model: every post in a run costs them, while a person who posts a lot is never asked for more than two.

However many challenges are solved, nobody can post more than 3 times in any minute (`POST_RATE_LIMIT_PER_MINUTE`). A post past that is refused with `429` before any challenge, so nobody solves challenges for a post that can't go through. The response says when the oldest of those posts is a minute old, so the next one can go through. That's in a `Retry-After` header and in the body:

```json
{ "error": "you can post at most 3 times a minute; try again in 40 seconds", "retryAfterSeconds": 40 }
```

A refused post is neither a post nor a challenge, so it doesn't start the run's minute again. The post after the wait still needs the run's challenges.

The server draws the image itself, with no third-party service. It's a PNG, so a robot can only read it from its pixels, and it's drawn to make that hard:
- the six characters come from an alphabet with no look-alikes, and are drawn as strokes rather than from a font;
- each character is scaled, rotated and sheared, and overlaps its neighbours;
- curves as thick as the characters' strokes run through them;
- the whole image is bent by a wave, a band of it is inverted, and it's covered in noise.

The proof of work makes every attempt cost CPU time, so guessing at scale is slow.

## Accounts

### `POST /register`

```json
{ "username": "Alice", "language": "es" }
```

The first request is answered with a [challenge](#challenges). The same request sent again with its solution returns `201` with `{ userId, username, language, apiKey, note }`. The key is shown only once, which `note` says. This endpoint is rate limited per IP (`REGISTER_RATE_LIMIT_PER_HOUR`, 10 an hour), and every attempt counts, so registering uses at least two.
- `userId` (a UUID) is the user's identity everywhere.
- `username` is a display name of 1 to 64 characters, and must be unique (exact match). A name already in use returns `409`, before any challenge. It's the credit shown on everything the user publishes.
- `language` is optional: the code of any of the instance's [languages](#languages), which [`GET /languages`](#get-languages) lists. The instance answers the user in it from this request on, challenge included. Without it, the user registers in the language the request is answered in: the one its `Accept-Language` header asks for, or the instance's default. A code that isn't one of the instance's returns `400`, with the ones that are. The response's `language` is the one the user got.

**An admin registers users without a challenge.** A request that carries an admin's [credentials](#authentication) returns `201` at once, with the new user's `userId` and `apiKey`, for the admin to pass on:

```bash
curl -X POST localhost:3000/register -H "Authorization: Bearer $ADMIN_KEY" -H "X-User-Id: $ADMIN_ID" \
  -H "Content-Type: application/json" -d '{"username":"Alice"}'
```

The [CLI](CLI.md#for-admins) sends this request as `evieverse register Alice`.

- The credentials are the admin's own, in the headers or as the `userId` and `apiKey` fields. They say who is asking, never who is being registered: the new user's id is always the server's to make.
- Only an admin's key spares the challenge. A request with any other user's credentials is answered with one, like a request with none.
- A request that names a user (`userId`, or `X-User-Id`) must carry that user's key: a wrong or missing one gets `401`, not a challenge. A key sent without a user id names nobody, so that request is anyone's, and gets a challenge.
- Everything else is as for anyone. A username in use returns `409`, and the request counts towards the limit per IP, though an admin uses one request per user, not two.
- A request with credentials is answered in [their user's language](#languages), so a user registered without a `language` gets the admin's, not the one `Accept-Language` asks for.

### `GET /users/:userId` and `PATCH /users/:userId`

`GET` returns a public profile: `{ userId, username, createdAt, admin, moderator, moderates }`. `admin` is whether the user is an admin, `moderator` whether they're a server moderator, and `moderates` lists the hashtags they're a moderator of, as [moderation](#moderation) describes. A user's language isn't part of their public profile, and neither are their settings: whether they take messages, and whether they show whom they follow and who follows them.

`PATCH` (authenticated, own profile only) updates `username`, `language`, `messages`, `showFollowing`, `showFollowers`, or any of them at once, and returns `{ userId, username, language, messages, showFollowing, showFollowers }` as they now are. A request with none of them gets `400`.
- `messages` is whether the user takes part in [messages between users](#post-messages): `true` (as every account starts) or `false`. With it off, the user is sent no messages and sends none. The server's [notices](#notices) still reach their inbox.
- `showFollowing` is whether anyone can list whom the user [follows](#following), and `showFollowers` whether anyone can list who follows them: `false` (as every account starts) or `true`, each on its own. The user can list both themselves either way. `showFollowing` also decides whether anyone can read the user's [following feed](#get-feedfollowing), which shows whose posts they follow.
- `username` must still be unique: `409` if it's taken. Feeds show the new name on all of the user's content at once: they look the credit up in Redis when they render.
- `language` is the code of any of the instance's [languages](#languages): `400` if it isn't one of them. The instance answers the user in it from this response on.
- A request that changes several changes them all or none.

```bash
curl -X PATCH localhost:3000/users/$USER_ID -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"apiKey\":\"$KEY\",\"language\":\"es\"}"
```

### `POST /users/:userId/key`

Authenticated, own account only. Replaces the account's API key: it revokes the key the request was sent with and returns a new one, as `201` with `{ userId, apiKey, note }`. Use it when a key may have leaked, or to change keys as a routine. It takes no fields but the [credentials](#authentication).

```bash
curl -X POST localhost:3000/users/$USER_ID/key -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

- The old key stops working at once, everywhere: every later request with it gets `401`. Every client that held it needs the new one.
- The new key is the account's only key. Any other key the account had is revoked with the one presented.
- The new key is shown only once, as at registration, which `note` says. If the response is lost on its way, the account has a key nobody knows, and no endpoint gets it back.
- Nothing else about the account changes: its `userId`, its name, its roles, its posts and what it follows stay as they are.
- A request for another user's key gets `403`, whoever sends it: an admin can't replace someone else's key.
- Of two requests sent at once with the same key, one gets the new key and the other `401`.
- Whoever holds a key can replace it, so this takes an account back from someone who copied its key only if its owner gets there first.
- The admin account of a [Terraform deployment](DEPLOY.md#the-admin-account) gets its key from the deployment, which sets it again whenever it runs its migration step. Replace that key through the deployment, not here: a key replaced here is revoked at the next deploy, and the deployment's key works again.

The [CLI](CLI.md) does this with `evieverse key rotate`, and saves the new key in its profile.

### `DELETE /users/:userId`

Authenticated. Deletes the account, for good: the user's own, or any account for an admin. It takes no fields but the [credentials](#authentication). Anyone else's account gets `403`, and a user who isn't there `404`.

```bash
curl -X DELETE localhost:3000/users/$USER_ID -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

The response says whether the account is gone yet:
- `200` with `{ userId, status: "deleted" }`: the account had no posts, and is gone.
- `202` with `{ userId, status: "pending_deletion", requestedAt }`: the account has posts. They're set for deletion as [`DELETE /content/:contentId`](#delete-contentcontentid) sets one, and the account goes with the last of them, when the [compactor](APP.md) next runs. A repeat of the request gets the same answer, with the same `requestedAt`.

From the response on, as far as anyone can tell the account is gone, whichever it is:
- Its keys stop working (`401`), and it isn't a user to look up (`404`), follow, message, block, ban or appoint to a role.
- Its posts are `404`, and leave every feed on the compactor's next run.
- Its follows, in both directions, its blocks, its mutes, its reports and its roles (admin, server moderator and hashtag moderator) are removed.
- A message it sent stays in the inbox it was sent to, with `from: null`. A [comment](#comments) it wrote stays, with an empty `username`, as a comment does whose author is gone.
- Its username stays taken until the account is gone for good: at once with no posts, otherwise when its last post is removed. Then anyone can register it.

The server always has an admin: the only admin's account can't be deleted (`409`). Make another user an admin first. A [banned](#bans) user can delete their own account too.

The [CLI](CLI.md) does this with `evieverse account delete --yes`, and `evieverse users delete <userId> --yes` for an admin.

### `GET /whoami`

Authenticated. Returns the account the key belongs to, its language, its roles and its settings: `{ userId, username, language, admin, moderator, moderates, banned, messages, showFollowing, showFollowers }`, with `admin`, `moderator` and `moderates` as in the profile. `banned` is whether a moderator [banned](#bans) the account, which can't then post, comment or send messages. `language` is the code of the language the instance answers the user in, `messages` is whether the user takes part in [messages between users](#post-messages), and `showFollowing` and `showFollowers` are whether they show whom they [follow](#following) and who follows them. The [CLI](CLI.md) checks a key with it when you sign in.

## Posts

### `POST /store`

Creates or updates a post. Send it as JSON, or as `multipart/form-data` with the file in a part named `content`. A file can also go straight to the content store first, and be posted by its `uploadId` ([`POST /uploads`](#post-uploads)). A [banned](#bans) user is refused (`403`), for an update of their own post as for a new one.

Every post has a `type`:

| `type` | The post |
| --- | --- |
| `image`, `video`, `audio` | A file of that type (`image/*`, `video/*` or `audio/*`) in `content` or sent before as `uploadId`, with an optional caption in `text`. An image is a JPEG, PNG, GIF or WebP, and is stored [without its metadata](#images). |
| `text` | Its `text`. |
| `link` | Its `url` alone. Any other file, such as a PDF or a web page, is posted as a link to it. |

| field | notes |
| --- | --- |
| `type` | Required: `image`, `video`, `audio`, `text` or `link`. |
| `text` | A text post's text (required), or an image's, video's or audio's caption (optional). At most 40,000 characters, trimmed of leading and trailing whitespace. A link post has none (`400`). An update sends the whole post again, so one without `text` drops the caption. |
| `url` | A link post's URL (required): `http` or `https`, at most 2,048 characters. Other types have none (`400`). |
| `content` | An image's, video's or audio's file: a file part (multipart), or a string in JSON with `contentEncoding: "base64"` (a JSON request can be at most 32 MB). Required for those types unless `uploadId` is given; a text or link post has none (`400`). A file larger than `MAX_UPLOAD_BYTES` (5 GiB) gets `413`. |
| `uploadId` | In place of `content`: a file already sent with an upload link from [`POST /uploads`](#post-uploads). Not together with `content` (`400`). |
| `contentType`, `filename` | Optional hints for the file. Otherwise its content type comes from the upload or the file extension, and it must match the post's `type`: an `image` post of a PDF gets `400`. An image's content type is then read from the file itself. |
| `contentId` | Optional. If set, updates content you own (otherwise 403). Content has one version: the update writes over it, and what it was before isn't kept. Feeds that already list it show it as it now is straight away. The update must have the same type and content type as the original (a PNG image stays a PNG), otherwise `400`. Content set for deletion can't be updated (`409`). Of two updates of the same content sent at once, the last to be written wins. |
| `tags` | Your hashtags. Required. A list (`["news", "mumbai"]`), or one string separated by commas or spaces (`"news, #Mumbai"`, as in a form field). Each is normalised (`#Central-Mumbai` becomes `centralmumbai`); one with nothing usable left, or more than 10, gets `400`. In `server` [tagging mode](#hashtags), so does one that isn't among the server's ([`GET /tagging`](#get-tagging) lists them). On an update, hashtags that aren't the content's change it, even when nothing else did. |
| `aiGenerated` | Optional. The publisher's declaration that the content was created with AI: `true` or `false` (a JSON boolean, or the string in a form field). Defaults to `false` for new content. An update that leaves it out keeps the content's value, and changing only this is an update too. Feeds return it on every record and can filter on it. |
| `comments` | Optional. Whether the post takes [comments](#comments): `true` or `false` (a JSON boolean, or the string in a form field). Defaults to `false` for new content. An update that leaves it out keeps the content's value, and changing only this is an update too. Turning it off closes and hides the post's comments without deleting them: they're back when it's turned on again. |
| `challengeId`, `challengeAnswer`, `challengeNonce` | The solution of a [challenge](#challenges), when the previous attempt was answered with one. |

The request is synchronous:
1. **The post is [moderated](#moderation).** It gets a trust score, which says where it goes. With the default thresholds, a post containing a word or phrase the server blocks is refused with `422`, and so is one that none of its hashtags is allowed on: nothing is stored. Otherwise it keeps the hashtags that are allowed, and is either published or, if its score is between the thresholds, held in the [moderation queue](#the-moderation-queue).
2. **If you already posted 3 times in the last minute** (`POST_RATE_LIMIT_PER_MINUTE`), the request is refused with `429` and when to try again ([above](#challenges)), and nothing else is done.
3. **If you posted, or were challenged to, less than a minute ago** (`CHALLENGE_POST_WINDOW_SECONDS`), the request is answered with a [challenge](#challenges) before anything else, and nothing is stored. Send it again with the solution, once per challenge: a post needs one, or two after a few posts in a row, and never more. New content and updates are posts; storing the same content again unchanged isn't. A post that fails doesn't count either, towards the run or the limit. Posts claim their place atomically, in Redis. So of several sent at once, only one gets through without a challenge, only one of several runs of challenges solved at once gets through, and no more get through than the limit allows.
4. The post's bytes (its file, a text post's text in UTF-8, or a link's URL) are written to `content/<id>`, the summary, with the [preview](#previews), to the summary store and Redis, and then the meta file. An update writes over what was there.
5. The database row is written and committed. If this fails, the request fails and nothing is added to any feed. New content's bytes, meta file and summary are removed. An update is already in the stores by then, and can't be taken back: send it again to complete it.
6. The same commit queues the post for the feed index: one row for each of its hashtags, and one for its publisher's own index. The request is then done, and the post can be read at `GET /content/:contentId`.
7. The [compactor](APP.md#8-the-compactor) puts the post in its hashtags' feeds, and its publisher's followers', on its next run: `COMPACT_INTERVAL_SECONDS` later at most (5 by default), plus the time the run takes. Until then no feed has it, so a client that wants to show a new post at once shows it from the response.

An update is in feeds the same way:
- Where a feed already lists the content, it shows as it now is straight away, in its original place.
- A hashtag the update dropped stops returning the content straight away.
- A hashtag the update added returns it after the compactor's next run.

The response is `201` for new content and `200` for an update, with `{ contentId, tags, preview, aiGenerated, comments }`, plus `removedTags` when moderation dropped some of the post's hashtags. An update of a text or link post that changes nothing (the same text or URL, AI flag, comments flag and hashtags as the content has) stores nothing, and returns `{ contentId, unchanged: true }`. A file is stored again whenever it's sent: the server doesn't compare it with the one it has.

A post held in the [moderation queue](#the-moderation-queue) is answered `202` instead, with `status: "pending_review"` beside the same fields. It's stored (steps 4 and 5), but nothing is queued for the feed index, so it's in no feed until a server moderator or an admin accepts it. A held update of published content erases the content's summary, which feeds render from, so they stop returning it at once.

```bash
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F type=video -F text="Sunrise over the harbour" -F tags=video,travel -F aiGenerated=true -F content=@clip.mp4
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d '{ "type": "link", "url": "https://example.com/report.pdf", "tags": ["news"] }'
```

#### Images

An image post is a JPEG, PNG, GIF or WebP. The server tells which by the file's first bytes, not by `contentType` or `filename`, and that's the post's `mimeType`: a PNG sent as `image/jpeg` is stored as `image/png`. Any other file gets `400`, including SVG, HEIC, AVIF, TIFF and BMP, and so does an image that's cut short or isn't laid out as its format says.

The image is stored without its metadata: EXIF (with the GPS position a phone records), XMP, IPTC, comments, embedded thumbnails, and anything appended after the image, such as the video of a motion photo. The pixels aren't touched: nothing is re-encoded, and colour profiles, transparency, animation and the image's orientation are kept. So the file `GET /content/:contentId/raw` returns isn't byte for byte the one you sent, and `size` is that of the file as stored.

Video and audio files are stored as they're sent, metadata included, under the content type they're sent with.

### `POST /uploads`

Gives a link to send an image, video or audio file straight to the content store, for files too large for a request to the server to carry. When the server runs as functions, that's anything over a few megabytes ([DEPLOY.md](DEPLOY.md#uploads)). A [banned](#bans) user is refused a link (`403`), as a link is for posting the file.

| field | notes |
| --- | --- |
| `type` | Required: `image`, `video` or `audio`, as the file will be posted. |
| `size` | Required: the file's size in bytes. More than `MAX_UPLOAD_BYTES` gets `413`. |
| `contentType`, `filename` | The file's content type, or a filename to tell it from. It must match `type`, otherwise `400`. |

The response is `201` with `{ uploadId, upload: { method, url, headers }, expiresAt, maxBytes }`. Then:
1. Send the file's bytes as the body of one request to `upload.url`, with the method and every header in `upload`, before `expiresAt` (15 minutes, `CONTENT_SIGNED_URL_SECONDS`). The link needs no other credentials, so a browser can send the file itself.
2. Post it: `POST /store` with `uploadId` in place of `content`, and the same `type`. The server checks the file as it would one sent in the request: its size (`413`), and that it's there and not empty (`400`). A post that gets a [challenge](#challenges) is sent again with the same `uploadId`: the file isn't uploaded again.

An upload nobody posts is removed after about a day. A user can ask for 10 links a minute (`UPLOAD_LINKS_PER_MINUTE`), then gets `429`. A server whose content store can't sign links (local disk, SFTP, WebDAV and the like) answers `501`: send the file in the request to `/store`.

```bash
UPLOAD=$(curl -s -X POST localhost:3000/uploads -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d '{ "type": "video", "filename": "clip.mp4", "size": 48211032 }')
curl -X PUT "$(echo "$UPLOAD" | jq -r .upload.url)" -H "Content-Type: video/mp4" --data-binary @clip.mp4
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d "{ \"type\": \"video\", \"uploadId\": $(echo "$UPLOAD" | jq .uploadId), \"tags\": [\"video\", \"travel\"] }"
```

Azure Blob Storage's links carry one more header, `x-ms-blob-type`, so send every header in `upload.headers` rather than assuming there's only `Content-Type`.

### Hashtags

A post's hashtags are the ones its publisher sends with it, in `tags`: at least one, and at most 10. Which hashtags they can be is up to the server, set with `TAGGING_MODE`:

| Mode | The hashtags a post can have | A hashtag that isn't one of them |
| --- | --- | --- |
| `user` (the default) | Any. | There's none. |
| `server` | The server's, `TAGGING_SERVER_TAGS`, of which the publisher chooses. A post gets the ones it's sent with, not the whole list. | The post is refused with `400`, even if its other hashtags are the server's: none is dropped silently. |

Either way, a post without `tags` gets `400`. These checks come before any [challenge](#challenges), so nobody solves one for a post that can't go through. [Moderation](#moderation) can then drop some of a post's hashtags, and refuses a post left with none.

In `server` mode the list is set in the configuration, which the server checks when it starts: it can be as long as the server wants, and needs at least one hashtag. Content that was posted under other hashtags before the list was set or changed keeps them, until it's updated: an update is checked like a new post.

### `GET /tagging`

Says which hashtags a post can have, for a client to offer people before they post. It needs no key.

```bash
curl localhost:3000/tagging
```

```json
{ "mode": "server", "allowedTags": ["news", "local", "sports"], "maxTags": 10 }
```

| field | notes |
| --- | --- |
| `mode` | The server's [tagging mode](#hashtags): `user` or `server`. |
| `allowedTags` | In `server` mode, every hashtag a post can have, normalised and in the order the configuration lists them, whether any post has used them yet or not. It's the whole list: there are no pages. In `user` mode, `null`: a post can have any hashtag. |
| `maxTags` | The most hashtags one post can have, in either mode: 10. |

This is the list to choose from. [`GET /tags`](#get-tags) is a different one: the hashtags posts have used, which in `server` mode leaves out the allowed ones nobody has posted under yet, and keeps the ones posts used before the list changed.

### Previews

| Type | Preview |
| --- | --- |
| `text` | `{ kind: "text", text }`: the first `FEED_PREVIEW_WORDS` words (default 100) of its text, and at most `FEED_PREVIEW_CHARS` characters (default 1,000) of them |
| `image`, `video`, `audio` | `{ kind, url, text }`: a link to the file, and its caption cut the same way. Without a caption, there's no `text`. |
| `link` | `{ kind: "link", url }` |

The whole text is in [`GET /content/:contentId`](#get-contentcontentid).

### `GET /content/:contentId`

Returns the publisher credit first: `publisher: { userId, username }`. Then come `contentId`, `preview`, `text` (a text post's whole text, or a caption), `tags`, `likes`, `mimeType`, `aiGenerated`, `comments` (whether the post takes [comments](#comments)), `size`, `contentUrl`, `createdAt` and `updatedAt`.

`GET /content/:contentId/raw` streams the content's bytes as they are now, with their content type. The link stays the same across updates, so a cache or CDN in front decides how long a copy is good for. On stores that support presigned URLs (S3, GCS, Azure, ...), it redirects to one instead, valid for `CONTENT_SIGNED_URL_SECONDS` (900). Bytes the server streams itself come with `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that sandboxes them: a browser shows or plays the file, and a page opened on it runs no script.

Both return `404` for content set for deletion.

Content waiting in the [moderation queue](#the-moderation-queue) isn't published, so both return `404` for it too, except to its publisher, to server moderators and to admins, who send their credentials in the headers (`Authorization: Bearer <apiKey>` and `X-User-Id`). They get it with `status: "pending_review"`.

### `DELETE /content/:contentId`

Authenticated. Only the original publisher or an [admin](#moderation) can delete content, otherwise `403`. Returns `202` with `{ contentId, status: "pending_deletion", requestedAt }`, and repeating the request returns the same response. When an admin deletes someone else's post, its publisher gets a [notice](#notices) in their inbox.

The content can't be read from then on: `GET /content` and `/raw` return `404`, likes return `404`, and updates (`POST /store` with its `contentId`) return `409`. Its [comments](#comments) go with it: they can't be read, added to or reported from then on.

Nothing is removed at the request. The content is set for deletion, and the compactor's next run (every `COMPACT_INTERVAL_SECONDS`, 5 by default) removes it from every hashtag's index and its publisher's, then deletes its comments, its database row (with its likes), its bytes, its meta file and its summary. Feeds return it until that run, and not after it, including on later pages of a feed session that already started.

### `POST /like`

```json
{ "userId": "...", "apiKey": "...", "contentId": "..." }
```

Each user can like a piece of content once, and likes are permanent. Returns `{ contentId, likes, alreadyLiked }`: `201` for a first like, and `200` with `alreadyLiked: true` for a repeated one, which doesn't count twice. Likes show up in feeds after the next compactor run. Content set for deletion, or waiting in the [moderation queue](#the-moderation-queue), can't be liked (`404`).

### `POST /report`

```json
{ "userId": "...", "apiKey": "...", "contentId": "...", "reason": "Looks like spam" }
```

Reports a post to the server's moderators, which puts it in [the report queue](#the-report-queue) for a server moderator or an admin to accept or delete. `reason` is optional: what's wrong with the post, in at most 500 characters. Returns `{ contentId, reportedAt, alreadyReported }`: `201` for a first report, and `200` with `alreadyReported: true` for a repeated one.

- Each user can report a post once. Reporting it again changes nothing: the first report stands, with its reason, also once the post has been accepted.
- The post stays published while it waits, and its publisher isn't told of the report.
- Content set for deletion, or waiting in the [moderation queue](#the-moderation-queue), can't be reported (`404`).
- A user can report 20 posts an hour (`REPORTS_PER_HOUR`), then gets `429` with when to try again, in a `Retry-After` header and as `retryAfterSeconds`. A repeated report doesn't count.

**Reporting a comment.** With `commentId` as well, the report is of that [comment](#comments) on the post, not of the post:

```json
{ "userId": "...", "apiKey": "...", "contentId": "...", "commentId": "...", "reason": "Unkind" }
```

It returns `{ contentId, commentId, reportedAt, alreadyReported }`, and everything above applies to the comment as it does to a post: one report per user, the comment stays published while it waits in the report queue, and its author isn't told. A comment that isn't there gets `404`, and so does one that waits in the moderation queue, or one on a post that doesn't take comments. A post's reports and its comments' are apart, and both count towards the same limit of reports an hour.

## Comments

A post takes comments if its publisher turned them on: the `comments` field of [`POST /store`](#post-store), which is off unless they say, and which they can change with an update. `GET /content/:contentId` and every feed record say whether a post takes them, as `comments`.

- A comment is text, of 1 to 2,000 characters. Comments are flat: there are no replies to a comment, and no likes.
- A comment is written once. It can be deleted, but not edited.
- Anyone who can read the post can read its comments, with no key. Any user can comment.
- Comments go through [moderation](#moderation) as posts do: the same trust score and thresholds refuse a comment, hold it in [the moderation queue](#the-moderation-queue), or publish it. Users can [report](#post-report) a published comment, which puts it in [the report queue](#the-report-queue).
- A post that doesn't take comments answers every endpoint here but `DELETE` with `404`, "this post doesn't take comments". If it had comments before its publisher turned them off, they're kept, and are back when comments are turned on again.
- A post's comments are deleted with the post.

A comment is `{ commentId, contentId, author: { userId, username }, text, createdAt }`. `author` is the user's current credit, as a post's `publisher` is.

### Reading comments

`GET /content/:contentId/comments` returns a page of the post's comments, and how many it has in all:

```json
{ "contentId": "...", "count": 2, "nextCursor": null, "comments": [
  { "commentId": "0199c2f4-7b1e-7000-9c5d-2f6a1c3b4d5e", "contentId": "...",
    "author": { "userId": "...", "username": "bob" },
    "text": "First!", "createdAt": "2026-11-10T14:02:00.000Z" },
  { "commentId": "0199c2f5-0a3c-7000-8e21-77d0b4a9c613", "contentId": "...",
    "author": { "userId": "...", "username": "carol" },
    "text": "Lovely light.", "createdAt": "2026-11-10T14:03:10.000Z" }
] }
```

- `order`: `oldest` (the default) returns the comments in the order they were sent, and `newest` the other way round.
- `limit`: the most comments in the page, 50 by default and at most 100.
- `cursor`: the previous page's `nextCursor`, which is the `commentId` of the last comment on that page. The next page starts just after it, so pages never repeat a comment or skip one, whatever is added or deleted meanwhile. A cursor doesn't expire.
- `count` is the number of published comments on the post, not on the page.
- A comment that waits in the moderation queue is in neither the list nor the count.

`GET /content/:contentId/comments/:commentId` returns one comment. A comment that waits in the [moderation queue](#the-moderation-queue) is `404` here, except to its author, to server moderators and to admins, who send their credentials in the headers (`Authorization: Bearer <apiKey>` and `X-User-Id`). They get it with `status: "pending_review"`.

Both return `404` for a post that isn't there, is set for deletion, or doesn't take comments. A post that waits in the moderation queue is `404` too, except to those who can read it there ([`GET /content/:contentId`](#get-contentcontentid)), and nobody can comment on it until it's accepted.

```bash
curl "localhost:3000/content/$CONTENT_ID/comments?order=newest&limit=20"
```

### `POST /content/:contentId/comments`

```json
{ "userId": "...", "apiKey": "...", "text": "Lovely light." }
```

Comments on a post. `text` is 1 to 2,000 characters, trimmed of leading and trailing whitespace. The post must be published and take comments, otherwise `404`. A [banned](#bans) user is refused (`403`). The response is the comment:

| Status | What happened |
| --- | --- |
| `201` | The comment is published. |
| `202` | The comment is held in the [moderation queue](#the-moderation-queue), and has `status: "pending_review"`. Only its author, server moderators and admins can read it until one of them accepts it. |
| `422` | The server doesn't trust the comment enough to keep it: nothing is stored. With the default thresholds, that's a comment containing a word or phrase [the server blocks](#blocked-words). |
| `429` | The user sent 10 comments in the last minute (`COMMENTS_PER_MINUTE`). The response says when to try again, in a `Retry-After` header and as `retryAfterSeconds`. Only comments that were published or held count. |

Comments need no [challenge](#challenges), and don't count towards the posts a user can send in a minute.

### `DELETE /content/:contentId/comments/:commentId`

Authenticated. Deletes a comment, at once and for good, and returns `{ contentId, commentId, status: "deleted" }`. Who can:
- **Its author**, whether it's published or waits in the moderation queue.
- **The publisher of the post it's on**, if it's published. A comment that waits in the moderation queue isn't theirs to read, so it's `404` to them.
- **An admin.**

Anyone else gets `403`, a server moderator included: they [reject](#the-moderation-queue) a comment in the moderation queue, or [delete](#the-report-queue) one in the report queue. A [tag moderator](#moderation) has no say over comments.

When someone other than its author deletes a comment, the author gets a [notice](#notices) in their inbox. The comment's reports, and its place in either queue, go with it. This works on a post that no longer takes comments too: what was written while it did is still its author's, and the publisher's, to delete.

## Following

A user can follow other users, and read a feed of their posts alone ([`GET /feed/following`](#get-feedfollowing)).

- `PUT /users/:userId/following/:followeeId` (authenticated as `userId`) follows `followeeId`. It returns `201` with `{ userId, followeeId, followedAt, alreadyFollowing: false }`. Following someone again changes nothing, and returns `200` with `alreadyFollowing: true` and the original `followedAt`.
- `DELETE /users/:userId/following/:followeeId` (authenticated as `userId`) stops following them, and returns `{ userId, followeeId, wasFollowing }`. Unfollowing someone you don't follow changes nothing, and returns `wasFollowing: false`. If it returns `503`, the follow is gone but the following feed couldn't be updated: send the request again.
- `GET /users/:userId/following` lists whom a user follows, and `GET /users/:userId/followers` who follows them, most recent follow first: `{ userId, following: [{ userId, username, followedAt }], nextCursor }` (with `followers` in the second). They take `limit` (100 by default, at most 1,000) and `cursor`, the previous page's `nextCursor`.

Rules:
- You can only change whom you follow yourself: a path naming another user gets `403`.
- Following yourself gets `400`, and following a user who doesn't exist gets `404`.
- A user can follow at most `MAX_FOLLOWING` users (1,000). Past that, a follow gets `409` until they unfollow someone.
- A follow or unfollow changes the following feed at once.

Who can read the two lists:
- Both are hidden to begin with. A user shows whom they follow with `showFollowing: true`, and who follows them with `showFollowers: true`, each on its own ([`PATCH /users/:userId`](#get-usersuserid-and-patch-usersuserid)), and hides either again with `false`.
- A list its user shows needs no key: anyone can read it.
- A list its user doesn't show is theirs alone to read, authenticated as `userId`. Anyone else gets `403`, with or without a key of their own, admins and moderators included. A wrong key gets `401`.
- Each list goes by its own user's setting alone. A user who shows who follows them shows those users, whether or not they in turn show whom they follow, and the same the other way round.
- The [following feed](#get-feedfollowing) goes with the list of whom a user follows, since its records show whose posts those are: anyone can read it if the user sets `showFollowing`, and only the user if they don't.

## Inbox

Every user has an inbox, which only they can read. Two things arrive in it:
- **Notices** from the server, when a moderator or an admin does something to one of the user's posts or comments, or mutes them on a hashtag.
- **Messages** from other users, unless the user turned those off or blocked the sender.

### Reading the inbox

`GET /users/:userId/inbox` (authenticated as `userId`) returns the inbox, newest first:

```json
{ "userId": "...", "unread": 2, "nextCursor": null, "inbox": [
  { "messageId": "...", "kind": "message", "from": { "userId": "...", "username": "alice" },
    "text": "Hello Bob", "sentAt": "2026-11-10T14:02:00.000Z", "readAt": null },
  { "messageId": "...", "kind": "tag_removed", "contentId": "...", "tag": "news",
    "excerpt": "The start of the post…",
    "text": "A moderator removed #news from your post. Updates of the post don't get it back.",
    "sentAt": "2026-11-10T13:40:00.000Z", "readAt": null }
] }
```

- `unread` counts everything unread in the inbox, not just this page.
- It takes `limit` (50 by default, at most 100) and `cursor`. `unread=true` lists only what's unread, and `unread=false` only what was read.
- A message's `from` is `null` if its sender's account is gone.
- Reading the list marks nothing as read.

`POST /users/:userId/inbox/read` marks everything in the inbox as read, or with `{ "messageIds": [...] }` (at most 1,000) only those. It returns `{ userId, read, unread }`: how many it marked, and how many are still unread. What was already read keeps its `readAt`.

`DELETE /users/:userId/inbox/:messageId` deletes a message or a notice, and returns `{ userId, messageId, wasThere }`.

A path naming another user's inbox gets `403`, for admins too. Messages and notices are deleted `INBOX_RETENTION_DAYS` (90) after they arrived, read or not.

### Notices

A notice has no `from`. Its `kind` says what happened, `text` says it in the reader's [language](#languages), and it names the post (`contentId`) and hashtag (`tag`) it's about, where there is one. `excerpt` is the start of the post, at most 200 characters (its text or caption, or a link's URL), so the publisher can tell which post it was once it's gone. A notice about a comment names the post the comment is on, and its `excerpt` is the start of the comment instead.

| `kind` | What happened | It has |
| --- | --- | --- |
| `post_accepted` | A server moderator or an admin accepted the post from [the moderation queue](#the-moderation-queue): it's published. | `contentId`, `excerpt` |
| `post_rejected` | They rejected it there: it's deleted. | `contentId`, `excerpt` |
| `post_deleted` | An admin deleted the post. | `contentId`, `excerpt` |
| `tag_removed` | A moderator removed a hashtag from the post. | `contentId`, `tag`, `excerpt` |
| `last_tag_removed` | A moderator removed the post's last hashtag, so the post is deleted. | `contentId`, `tag`, `excerpt` |
| `tag_muted` | A moderator muted the user on a hashtag. | `tag` |
| `tag_unmuted` | A moderator ended the mute. | `tag` |
| `comment_accepted` | A server moderator or an admin accepted the user's [comment](#comments) from the moderation queue: it's published. | `contentId`, `excerpt` |
| `comment_rejected` | They rejected it there: it's deleted. | `contentId`, `excerpt` |
| `comment_deleted` | Someone else deleted the user's comment: the post's publisher, an admin, or a server moderator or an admin from the report queue. | `contentId`, `excerpt` |
| `user_banned` | A server moderator or an admin [banned](#bans) the user. | |
| `user_unbanned` | They ended the ban. | |

- A notice doesn't say which moderator or admin it was, and a `comment_deleted` notice doesn't say whether it was one of them or the post's publisher.
- Nobody gets a notice of what they did themselves: a moderator who removes a hashtag from their own post, say.
- There's no notice when a post is approved under a hashtag, or when a post or a comment is reported. A post that's refused or held when it's sent has that in the response to `POST /store`, not in a notice, and likewise a comment. Nor is there one for the comments that go when their post is deleted, or for a new comment on a user's post.
- Notices can't be turned off or blocked, and they don't count towards any limit.
- A client should show a `kind` it doesn't know by its `text`: later versions may add kinds.

### `POST /messages`

```json
{ "userId": "...", "apiKey": "...", "to": "<the recipient's userId>", "text": "Hello Bob" }
```

Sends another user a message, which lands in their inbox. `text` is 1 to 2,000 characters, as written: the server doesn't check it for blocked words. Returns `201` with `{ messageId, to: { userId, username }, sentAt }`. The sender keeps no copy: a message is in the recipient's inbox only.

It's refused with `403` when:
- the sender is [banned](#bans). A banned user can still be sent messages, and read them;
- the sender turned messages off (`PATCH /users/:userId` with `messages: false`): turning them off stops sending as well as receiving;
- the sender blocks the recipient;
- the recipient turned messages off, or blocks the sender. Both get the same answer, "this user doesn't take messages from you", so a sender can't tell that they were blocked.

A message to yourself gets `400`, and one to a user who doesn't exist gets `404`. A user can send 10 messages a minute (`INBOX_MESSAGES_PER_MINUTE`), then gets `429` with when to try again, in a `Retry-After` header and as `retryAfterSeconds`. Refused messages don't count.

### Blocks

A user can block other users. No message goes between a user and someone they block, in either direction. A block changes nothing else: both still see each other's posts and can follow each other, and messages that already arrived stay in the inbox.

- `PUT /users/:userId/blocked/:blockedId` (authenticated as `userId`) blocks `blockedId`. It returns `201` with `{ userId, blockedId, blockedAt, alreadyBlocked: false }`, or `200` with `alreadyBlocked: true` and the original `blockedAt` if they were already blocked.
- `DELETE /users/:userId/blocked/:blockedId` ends the block, and returns `{ userId, blockedId, wasBlocked }`.
- `GET /users/:userId/blocked` lists whom the user blocks, most recently blocked first: `{ userId, blocked: [{ userId, username, blockedAt }], nextCursor }`. It takes `limit` (100 by default, at most 1,000) and `cursor`.

Blocks are private, and there's no setting that shows them: all three need the user's own key, and a path naming another user gets `403`. Blocking yourself gets `400`, and blocking a user who doesn't exist gets `404`. The blocked user isn't told. Admins and moderators can be blocked like anyone, which stops their messages but not the server's notices.

## Feeds

### `GET /feed`

A feed of one or more hashtags.

```bash
curl "localhost:3000/feed?tags=news,mumbai&hours=24"
```

- `tags`: one or more hashtags (letters, digits, `_`; a leading `#` is fine). Most feeds ask for several.
- `hours`: the feed's window. The feed is of the posts created in the past this many hours, and of no others. One of `1`, `2`, `4`, `8`, `12`, `24` (1 day, the default), `48` (2 days), `72` (3 days), `168` (7 days), `336` (14 days), `504` (21 days), `720` (30 days), `1440` (60 days) or `2160` (90 days). Any other value gets `400`.
- `limit`: the most posts in the page, up to `FEED_MAX_PAGE_SIZE` (default 100). Left out, `FEED_PAGE_SIZE` (default 50).
- `algorithm`: `popular` (the default) or `chronological`.
  - `popular` returns the window's most liked content first: the latest and greatest, for showcasing a tag.
  - `chronological` returns the window's newest content first, whatever its likes or its hashtag.
- `addRelated`: optional. `true` also returns posts under the hashtags [related](#related-hashtags) to the ones asked for: those that tend to be on the same posts. Left out or `false`, the feed is of the hashtags asked for alone.
- `aiGenerated`: optional. `true` returns only content its publisher declared created with AI, `false` only content declared not created with AI. Left out, the feed returns both. Everything below then applies to the matching content alone, so the page, the turns between tags and the fresh slots are all spent on it.
- `moderated`: optional. `false` returns only the posts no moderator of their hashtag has approved, which is [that hashtag's queue](#a-hashtags-queue); `true` only those one has. Left out, the feed returns both. It filters as `aiGenerated` does, and the two combine.
- `cursor`: optional, taken from the previous page's `nextCursor`.

How the feed is assembled:

1. **Window:** the feed is of the posts created in the past `hours`, taken as one span of time. A post's place depends on its likes, or on when it was created, and never on which day that was. A page the window can't fill is left short: the feed doesn't reach back past its window.
2. **Page size:** a page holds at most `limit` posts (50 by default).
3. **Order:** each tag's posts are ordered by likes (most first), then recency.
4. **Turns:** the requested tags take turns, so each gets an equal share of the page. A tag that runs out lets the others continue. Content carrying several requested tags appears once.
5. **Fresh content:** so that new posts on busy tags aren't buried under liked ones (and can earn likes at all), the 2nd pick per tag, and then every `FEED_FRESH_EVERY`th (default 4), is new content with at most `FEED_FRESH_MAX_LIKES` likes (default 0). It's sampled from that tag's `FEED_FRESH_POOL` newest such records in the window (default 200), in an order that goes by a seed chosen per feed session, so different viewers see different new posts. A fresh slot is skipped once the likes order has already reached unliked content. `FEED_FRESH_EVERY=0` turns this off.

**Chronological** feeds work the same way, in order of time instead of likes. Each tag's posts are ordered newest first (step 3), and instead of the tags taking turns (step 4), the next post comes from whichever hashtag's is the newest. So the page is the newest `limit` posts of the hashtags together, and the next page carries on from there. There are no fresh slots (step 5), which exist to lift new posts out of a likes order.

Either way, the feed is of the posts the hashtag's index keeps. For a busy hashtag that's each day's most liked posts, fewer the older the day ([APP.md](APP.md#retention-and-quotas)).

The response shape is:

```
{ window: { from, to }, count, truncated, nextCursor,
  related: [ "<tag>", ... ],        // only with addRelated=true
  tags: { "<tag>": [ record, ... ] } }
```

- `window` is the span of time the feed is of: `hours` back from when its first page was asked for.
- `count` is the number of records in the page, and `truncated` whether the window holds more: `nextCursor` then gets the next page.
- `tags` holds each hashtag's records, in the feed's order: most liked first in a `popular` feed, newest first in a `chronological` one. A hashtag with no record in the page is left out. To show a `popular` page as one list, take a record from each hashtag's list in turn; to show a `chronological` one, merge the lists by `createdAt`.

Each record is `{ contentId, publisher: { userId, username }, mimeType, aiGenerated, comments, preview, tags, likes, moderated, createdAt, updatedAt }`:
- `aiGenerated` is the publisher's declaration of whether the content was created with AI.
- `comments` is whether the post takes [comments](#comments). A record doesn't say how many it has: [`GET /content/:contentId/comments`](#reading-comments) does.
- `moderated` is whether a moderator of the hashtag the record is listed under has [approved](#a-hashtags-queue) it there. It's per hashtag, so the same post can be `true` under one and `false` under another.
- `preview` follows the post's type, as [previews](#previews) lists.
- `publisher` is the user's current credit, so a renamed user shows under their new name everywhere at once.

**Pagination:** the cursor says where the feed has got to: the last record it returned under each hashtag, with the end of the window, the algorithm, the related hashtags the first page added, the `aiGenerated` and `moderated` filters and the fresh-content seed. The next page reads the hashtags' indexes as they are by then, and carries on after those records. So:
- Every page is of the first page's window. Posts newer than the first page show when the reader starts over.
- A post isn't returned twice, and what was deleted, held or taken out of a hashtag since the page before is left out, without anything else shifting. There are two exceptions, which a client that shows one list can settle by dropping a `contentId` it already has: a post returned in a fresh slot and liked afterwards, and, in a `popular` feed of several hashtags, a post that lost the hashtag it was returned under and still carries another.
- What the compactor has applied since the page before shows: new like counts, and what moderators approved or removed.
- A session can miss a post that came to be ahead of where it had got to: one liked past that point between two pages of a `popular` feed, or one that reached the index late. It's there when the reader starts over.
- Later pages must ask for the same `tags`, `hours`, `algorithm`, `addRelated`, `aiGenerated` and `moderated`, otherwise `400`.
- A cursor doesn't expire. One issued by an earlier release of the server gets `410`, and the client should start over; one that isn't valid gets `400`.

### Related hashtags

With `addRelated=true`, the feed is planned over the hashtags asked for and then the ones related to them, as if all had been asked for: they take turns with the others in a `popular` feed, a post under several of them is returned once, and their records are listed under their own names in `tags`. The response names the hashtags it added in `related`, most related first (an empty list if there are none yet).

A hashtag is related to another when it tends to be on the same posts. Every post stored counts once for each of its hashtags and once for each pair of them, and the counts build up from there. `#pets` is related to `#dogs` once at least `FEED_RELATED_MIN_POSTS` posts (default 5) carry both, and those are at least `FEED_RELATED_MIN_PERCENT` (default 20) percent of the posts that carry `#dogs`. It's one-sided: a small hashtag can be related to a big one that most of its posts also carry, without the big one being related to it.

- A feed adds at most `FEED_RELATED_TAGS` hashtags (default 3) for each one asked for, its most related first, and reads at most 20 hashtags in all. `FEED_RELATED_TAGS=0` turns related hashtags off: `related` is then always empty.
- The compactor works the related hashtags out from the counts and keeps them in Redis, so a feed with `addRelated` still reads no database. New counts show after its next run, once they're `COMPACT_GRACE_SECONDS` old.
- An update counts only the hashtags it adds. Counts never go down: a post that is deleted, rejected from the moderation queue or has a hashtag removed stays counted.

### `GET /feed/following`

The posts of the users a user [follows](#following), newest first, whatever their hashtags.

```bash
curl "localhost:3000/feed/following?userId=$USER_ID" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

Each record names its publisher, so the feed shows whom the user follows, and it's read by the same rule as [the list of them](#following):
- It's the user's own to read, authenticated as `userId` with the `Authorization` and `X-User-Id` headers.
- Anyone can read it, with no key, if the user shows whom they follow (`showFollowing`).
- Otherwise anyone else gets `403`, with or without a key of their own, admins and moderators included. A wrong key gets `401`, and a `userId` that is no user's gets `404`.

It takes:
- `userId`: whose follows. Required.
- `limit`: as for `/feed`: at most `FEED_MAX_PAGE_SIZE` (100), and `FEED_PAGE_SIZE` (50) when left out.
- `aiGenerated`: optional, as for `/feed`.
- `cursor`: optional, taken from the previous page's `nextCursor`.

The response is `{ count, truncated, nextCursor, records: [record, ...] }`, with each record shaped as in `/feed`. There's no window, and there are no turns or fresh slots: posts come in order of when they were created, newest first, reaching back `FEED_MAX_LOOKBACK_DAYS` (90). A user who follows nobody gets no records.

What it shows:
- Every post of each user followed, up to `FEED_AUTHOR_DAY_MAX_POSTS` (1,000) of them per UTC day: the newest, whatever their likes.
- A new post after the compactor's next run, as on `/feed`. An updated post shows as it now is at once, in its original place.
- Deletions and like counts after the next compactor run, as on `/feed`.

**Pagination:** the cursor names the last post the page returned, and the next page starts just after it. So pages never repeat a post, or skip one that was there when the previous page was read, even while new posts arrive and the compactor runs. Posts newer than the first page show when the reader starts over. A cursor doesn't expire. One that isn't valid, including a cursor from `/feed`, gets `400`.

### `GET /tags`

Lists the hashtags posts have used, most recently active first: `{ tags: [{ tag, lastActiveAt }] }`. `prefix` (letters, digits and `_`, with or without `#`) keeps those that start with it, and `limit` sets how many (200 by default, at most 1,000). The hashtags a post can have are another matter: [`GET /tagging`](#get-tagging) says those.

```bash
curl "localhost:3000/tags?prefix=mum"
```

## Rules

### `GET /rules`

Gives the server's rules, and its modification disclosure. It needs no key, so a client can show both to someone before they register.

```bash
curl localhost:3000/rules
```

```json
{
  "modificationDisclosure": { "modified": true, "release": "0.1.0", "sourceUrl": "https://git.example.com/our-evieverse" },
  "rules": [
    { "ruleId": "0b7c0f5e-…", "position": 1, "text": "Be kind.", "createdAt": "2026-11-15T14:02:00.000Z", "updatedAt": "2026-11-15T14:02:00.000Z" },
    { "ruleId": "5e1a9d42-…", "position": 2, "text": "No spam.", "createdAt": "2026-11-15T14:03:00.000Z", "updatedAt": "2026-11-15T14:03:00.000Z" }
  ]
}
```

| field | notes |
| --- | --- |
| `modificationDisclosure.modified` | `true` if the server's operator states that it runs a modified version of Evieverse: one whose source code differs from a release, as the [additional license terms](../LICENSE.md) define it. `false`: it runs a release. It's the operator's statement (`EVIEVERSE_MODIFIED`), which the server checks against nothing, and no request changes it. |
| `modificationDisclosure.release` | The release of Evieverse the server runs, or for a modified version, the release it's based on, such as `0.1.0`. |
| `modificationDisclosure.sourceUrl` | Where the server's source code can be obtained: an `http` or `https` address (`EVIEVERSE_SOURCE_URL`). A modified version always gives one. Otherwise `null`, unless the operator set one. |
| `rules` | Every rule, in the order the admins gave them. It's the whole list: there are no pages, and a server has at most 100. `[]` where there are none. |
| `ruleId` | The rule's id, which the admin endpoints take. |
| `position` | The rule's place in the list, counted from 1. |
| `text` | The rule, as its admin wrote it: at most 2,000 characters. |
| `createdAt`, `updatedAt` | When the rule was added, and when its text or its place was last changed. A rule that moved only because another was added, moved or removed keeps its `updatedAt`. |

The server gives the rules and does nothing else with them: no post is checked against a rule. What it enforces is under [Moderation](#moderation).

### Keeping the rules

Admins add, change and remove rules. These authenticate as the other write endpoints do; anyone else gets `403`.

| Endpoint | What it does |
| --- | --- |
| `POST /rules` | `{ "text": "...", "position": 2 }` adds a rule: `201` with the rule, as `GET /rules` gives it. `text` is 1 to 2,000 characters, once the spaces around it are removed. `position` is optional: without it the rule goes at the end, and with it, at that place, moving the rules from there on down by one. A position past the end is the end. A server that already has 100 rules gets `409`. |
| `PATCH /rules/:ruleId` | `{ "text": "...", "position": 1 }`, either or both: changes the rule's text, moves it to that place, or both, and returns the rule. With neither, `400`. A rule that's already what the request asks for is left as it is. |
| `DELETE /rules/:ruleId` | Removes the rule: `{ ruleId, wasThere }`. The rules after it move up by one. |

A rule that doesn't exist gets `404` from `PATCH`, and `wasThere: false` from `DELETE`. A `ruleId` that isn't an id, an empty or too long `text`, or a `position` that isn't a whole number from 1 gets `400`.

## Moderation

The server's admins, its server moderators and each hashtag's moderators decide what's published, and under which hashtags. Their rules are checked when a post or an update is written, and what they decide about a post is written into the feed index, so feeds never consult the database for any of it and it costs readers nothing.

There are three queues to decide on. The first two hold [comments](#comments) as well as posts, in one list:
- [The moderation queue](#the-moderation-queue) holds the posts, under any hashtag, and the comments that the server didn't trust enough to publish. They aren't published until a server moderator or an admin accepts them.
- [The report queue](#the-report-queue) holds the published posts and comments that users reported, until a server moderator or an admin accepts or deletes them. They stay published while they wait.
- [Each hashtag's queue](#a-hashtags-queue) is every post published under the hashtag that none of its moderators has decided on yet. Those posts are published all along. Comments aren't in it.

**Admins** can delete any content (`DELETE /content/:contentId`) and any comment, accept or reject the posts and comments in the moderation queue, appoint and remove server moderators and tag moderators, keep the server's list of blocked words, and make other users admins or revoke the role. They can also do whatever a server moderator can, and whatever a tag moderator can on every hashtag, and they [register users](#post-register) without a challenge.

**Server moderators** are appointed by an admin (`PUT /moderators/:userId`) to work through [the moderation queue](#the-moderation-queue) and [the report queue](#the-report-queue), so that doesn't take an admin. They can read the moderation queue and the posts and comments waiting in it, and accept or reject each; and read the report queue and the reports of each post or comment in it, and accept or delete each. That's all the role gives:
- They can't delete published content or a published comment that nobody has reported, or anyone else's outside the two queues.
- They can't keep the server's blocked words, or appoint anyone.
- They have no say over a hashtag unless they're also one of its moderators. A user can be both.

Admins and moderators can do all of it with the [CLI](CLI.md) the server ships, which signs in with their own API key.

**The first admin** comes from whoever runs the server, since making an admin over the API takes one. The [Terraform modules](DEPLOY.md#the-admin-account) create an admin account with every deployment, and anywhere else the operator makes one from the command line ([README.md](../README.md#the-first-admin)). From then on, admins make more over the API (`PUT /admins/:userId`), and the API never leaves the server without one: revoking the only admin gets `409`.

**Tag moderators** are appointed by an admin to one or more hashtags. For each of those, they can:
- keep the hashtag's list of blocked words;
- mute users on the hashtag, so that the user's new posts and updates don't get it;
- work through [the hashtag's queue](#a-hashtags-queue): approve the content under it, or remove the hashtag from content.

A tag moderator has no say over comments. A hashtag's blocked words and mutes apply to posts alone, and a comment on a post under the hashtag isn't its moderators' to accept, reject or delete.

A user's profile (`GET /users/:userId`) shows whether they're an `admin` or a server moderator (`moderator`), and the hashtags they moderate (`moderates`).

**Server moderators and admins can [ban](#bans) a user**, and admins can delete any [account](#delete-usersuserid).

### Bans

A server moderator or an admin bans an account with `PUT /banned/:userId`, and ends the ban with `DELETE /banned/:userId`. A banned user keeps their account, their key and their posts, and can still read everything, but is refused (`403`, "your account is banned") by whatever writes a post, a comment or a message:
- `POST /store`, for a new post and for an update of one of their own;
- `POST /content/:contentId/comments`;
- `POST /messages`;
- `POST /uploads`, since a link is for posting the file.

That is all a ban stops. A banned user can still read their inbox, receive messages, delete their own posts and comments, change their settings and key, like and report posts, follow users, and [delete their account](#delete-usersuserid). A ban doesn't take down what was posted before it: a moderator deletes that as they would any content.

- A ban is of one account: an admin or a server moderator can't be banned (`403`) until their role has ended, and nobody can ban themselves (`400`).
- The user gets a [notice](#notices), once: `user_banned`, and `user_unbanned` when the ban ends. A ban has an optional `reason` (at most 500 characters), which only server moderators and admins can read.
- Banning a user who is banned changes nothing, and returns `200` with `alreadyBanned: true` and the first ban's time and reason. Ending a ban that isn't there returns `wasBanned: false`.
- A user's own [`GET /whoami`](#get-whoami) says whether they're `banned`. It isn't part of their public profile.
- A ban doesn't remove a role: appointing a banned user as a moderator is allowed, but they can't then be banned again until the role ends.
- The ban is a column of the account, so it takes effect with the next request, and doesn't change feeds.

**The user is told.** When a moderator or an admin removes a hashtag from a post, accepts or rejects it in the moderation queue, or deletes it, its publisher gets a [notice](#notices) in their [inbox](#inbox). So does a user who is muted on a hashtag, or whose mute ends, and the author of a comment that is accepted or rejected in the moderation queue, or that someone else deletes.

**What happens to a post.** Every new post and update is checked before the limit on posts a minute and before any [challenge](#challenges), so nobody solves challenges for a post that can't go through. A refused post isn't a post: nothing is stored, and it doesn't count towards the run or the limit.
1. The post gets a **trust score**, from 0 (not trusted at all) to 100. It starts at 100 and goes through each of the server's [trust plugins](TRUST_PLUGINS.md), which can only lower it. The server comes with one, `blocked_words`: a post containing a word or phrase on the server's list scores 0.
2. The score says where the post goes, by two thresholds:

   | Score | Where the post goes |
   | --- | --- |
   | Less than `TRUST_SCORE_DELETE_BELOW` (25) | It's deleted on arrival: refused with `422`, and nothing of it is kept. |
   | From there up to `TRUST_SCORE_ALLOW_FROM` (75) | It's held in [the moderation queue](#the-moderation-queue) for a server moderator or an admin. |
   | `TRUST_SCORE_ALLOW_FROM` or more | It's published. |

   So with the defaults and no other plugin, a post with one of the server's blocked words is refused, and every other post is published. `TRUST_SCORE_DELETE_BELOW=0` holds posts with a blocked word in the queue instead of refusing them, and `TRUST_SCORE_ALLOW_FROM=101` holds every post. The score is used for this and nothing else, and is kept nowhere but beside a post in the moderation queue.
3. Each of its hashtags is dropped if its publisher is muted on that hashtag, if a moderator removed that hashtag from this content, or if the post contains a word or phrase on that hashtag's list.
4. A post with no hashtag left is refused with `422`, since a post can't go live without one. The response says why each hashtag was dropped:

   ```json
   { "error": "none of the post's hashtags is allowed on it, and a post needs one, so it wasn't published",
     "removedTags": [{ "tag": "news", "reason": "muted" }] }
   ```
5. Otherwise it's published, or held, with the hashtags left, and the response lists those dropped in `removedTags`. Each `reason` is `muted`, `removed` or `blocked_word`.

If what's left is exactly the content's hashtags, on a text or link post that's otherwise the same and going where the content already is, nothing is stored and the response is `unchanged: true` (with `removedTags`).

**What happens to a comment.** A [comment](#post-contentcontentidcomments) goes through steps 1 and 2 as a post does: the same plugins score it, and the same two thresholds refuse it (`422`), hold it in the moderation queue (`202`) or publish it (`201`). A plugin is told that it's looking at a comment, and on which post ([TRUST_PLUGINS.md](TRUST_PLUGINS.md)). Steps 3 to 5 are about hashtags, which a comment doesn't have: a hashtag's blocked words and mutes don't apply to it. It's checked before the limit on comments a minute, so a refused comment doesn't count towards it.

### The moderation queue

A post whose trust score is between the two thresholds is stored, but not published: `POST /store` answers `202` with `status: "pending_review"`, and the post is in no feed, not even its publisher's followers'. Only its publisher, server moderators and admins can read it ([`GET /content/:contentId`](#get-contentcontentid)), and nobody can like it.

Server moderators and admins read the queue with `GET /moderation/queue`, longest waiting first, and decide on each post:
- **Accept** (`POST /moderation/queue/:contentId/accept`) publishes it, under its hashtags and to its publisher's followers, as posted when it was sent: its `createdAt` doesn't change. It can be read at once, and is in feeds after the compactor's next run, like any post. It then waits in each of its hashtags' queues like any published post.
- **Reject** (`POST /moderation/queue/:contentId/reject`) takes it down, as `DELETE /content` does.

The publisher can update a held post, or delete it. Each update is scored again:
- One that's held too keeps the post's place in the queue.
- One that scores high enough to be published is published, with nobody's decision.
- An update of *published* content that's held takes the content out of every feed at once, until it's accepted. What the content was before isn't kept: content has one version.

**Comments wait in the same queue.** A [comment](#comments) whose trust score is between the thresholds is stored, but not published: `POST /content/:contentId/comments` answers `202` with `status: "pending_review"`, and the comment is neither in the post's list of comments nor in its count. Only its author, server moderators and admins can read it. `GET /moderation/queue` lists it among the posts, in the one order, and each item's `kind` says which it is: `"post"` or `"comment"`. They decide on it as on a post:
- **Accept** (`POST /moderation/queue/:contentId/comments/:commentId/accept`) publishes it at once, among the post's comments where it was sent, not where it was accepted: its `createdAt` doesn't change.
- **Reject** (`POST /moderation/queue/:contentId/comments/:commentId/reject`) deletes it, at once and for good.

Its author is told of either with a [notice](#notices). The author can delete a comment that waits, which takes it out of the queue; a comment can't be edited, so there are no updates to score. A comment that waits on a post that is deleted leaves the queue with the post.

### The report queue

Any user can report a published post ([`POST /report`](#post-report)). A post with a report nobody has decided on is in the report queue. It stays published while it waits, and its publisher isn't told.

Server moderators and admins read the queue with `GET /moderation/reports`, longest reported first. Each post comes with how many such reports it has (`reports`) and since when (`reportedAt`), and `GET /moderation/reports/:contentId` lists them: who made each, when, and the reason they gave. They decide on each post:
- **Accept** (`POST /moderation/reports/:contentId/accept`) leaves the post as it is, and settles the reports it had, which takes it out of the queue.
- **Delete** (`POST /moderation/reports/:contentId/delete`) takes it down, as `DELETE /content` does. Its reports go with it.

What happens next:
- A user reports a post once, so those whose reports an acceptance settled can't put the post back in the queue. A report by anyone else does, at the end of the queue.
- A post its publisher deletes leaves the queue. One they update stays in it: the reports are still to be decided on, for the post as it now is.
- A reported post whose update is held in [the moderation queue](#the-moderation-queue) is in both queues, and each is decided on its own.

**Comments wait in the same queue.** A published [comment](#comments) that a user reported ([`POST /report`](#post-report) with `commentId`) is listed by `GET /moderation/reports` among the posts, in the one order, with the same `reports` and `reportedAt`, and each item's `kind` says which it is: `"post"` or `"comment"`. `GET /moderation/reports/:contentId/comments/:commentId` lists a comment's reports. They decide on it as on a post:
- **Accept** (`POST /moderation/reports/:contentId/comments/:commentId/accept`) leaves the comment as it is, and settles the reports it had.
- **Delete** (`POST /moderation/reports/:contentId/comments/:commentId/delete`) deletes it, at once and for good, with its reports. Its author gets a [notice](#notices), which doesn't mention the reports.

A comment that its author, the post's publisher or an admin deletes leaves the queue, and so do the comments of a post that is deleted. A post's reports and its comments' are decided on apart: accepting a post settles none of its comments' reports.

### A hashtag's queue

Every post is published under its hashtags unmoderated. Each record of a hashtag's feed says so: `moderated` is `false` until one of the hashtag's moderators approves the post there. So a hashtag's queue is its feed without the approved posts, and is read like any feed, by anyone:

```bash
curl "localhost:3000/feed?tags=news&moderated=false&hours=2160"
```

A feed is of its window, which is the past day unless it says. So a queue asks for the widest one, `hours=2160` (90 days), to get every post that waits and not only the last day's.

A moderator of the hashtag takes a post out of its queue in one of two ways:
- **Approve it** (`PUT /content/:contentId/tags/:tag`). Its records under that hashtag are `moderated: true` from then on. The approval is of the post as it was, so an update of the post puts it back in the queue.
- **Remove the hashtag from it** (`DELETE /content/:contentId/tags/:tag`). The post leaves the hashtag's feeds, and loses the hashtag for good: the publisher's updates don't get it back (`removedTags` gives the reason `removed`).

Both are recorded at once, and show in the hashtag's feeds after the compactor's next run, which applies them: it flags the post as moderated in the hashtag's index, or takes the hashtag off the post.

Moderation is per hashtag: a post under `#news` and `#mumbai` waits in both queues, and approving it under one leaves it in the other's. A feed of several hashtags with `moderated=false` returns the posts not approved under at least one of the hashtags asked for.

Later pages of a [feed session](#get-feed) are of the queue as it is by then: a post approved or removed since the page before, once the compactor has run, isn't on them.

### Blocked words

The server has a list of blocked words, which its admins keep, and so has each hashtag, kept by its moderators. A post containing one of the server's isn't published, and a post containing one of a hashtag's doesn't get that hashtag ([above](#moderation)).

**What's checked for blocked words:** the post's hashtags, its whole text (a text post's text, or an image's, video's or audio's caption), a link's URL, and a file's filename. What's in an image, video or audio file isn't checked.

**How words match:** whole words and phrases, whatever their case or Latin accents. `spam` matches "Spam!" but not "spammers", `cafe` matches "Café", and `buy now` matches "Buy... NOW". A word is a run of letters and digits, so punctuation and spaces between a phrase's words don't matter. Entries are normalised the same way when they're added (`"  BUY  now!"` is stored as `buy now`). An entry has at most 8 words and 100 characters, and a list holds at most 10,000 entries.

### Moderation endpoints

They authenticate as the other write endpoints do. `:tag` is a hashtag as `/feed` takes it: letters, digits and `_`, with or without a `#` (sent as `%23`).

| Endpoint | Who | What it does |
| --- | --- | --- |
| `GET /admins` | Admins | The server's admins, by username: `{ admins: [{ userId, username }] }` |
| `PUT /admins/:userId` | Admins | Makes a user an admin: `201` with `{ userId, username, alreadyAdmin: false }`, or `200` with `alreadyAdmin: true` if they already were. |
| `DELETE /admins/:userId` | Admins | Revokes the role: `{ userId, wasAdmin }`. An admin can revoke their own, but not while they're the only admin (`409`): make another user an admin first. |
| `GET /moderators` | Admins | The server moderators, by username: `{ moderators: [{ userId, username }] }` |
| `PUT /moderators/:userId` | Admins | Makes a user a server moderator: `201` with `{ userId, username, alreadyModerator: false }`, or `200` with `alreadyModerator: true` if they already were. |
| `DELETE /moderators/:userId` | Admins | Ends it: `{ userId, wasModerator }`. What they decided in the queue stays decided. |
| `GET /banned` | Server moderators, and admins | The banned users, most recently banned first: `{ banned: [{ userId, username, bannedAt, reason, bannedBy }], nextCursor }`. `reason` is `null` where none was given, and `bannedBy` is `{ userId, username }`, or `null` once that account is gone. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `PUT /banned/:userId` | Server moderators, and admins | [Bans](#bans) a user, with `{ "reason": "..." }` if there's one to give: `201` with `{ userId, username, bannedAt, reason, alreadyBanned: false }`, or `200` with `alreadyBanned: true` and the first ban's `bannedAt` and `reason`. Not an admin or a server moderator (`403`), or yourself (`400`). |
| `DELETE /banned/:userId` | Server moderators, and admins | Ends a ban: `{ userId, wasBanned }`. |
| `GET`, `POST`, `DELETE /moderation/blocked-words` | Admins | Lists, adds or removes the server's blocked words. `POST` and `DELETE` take `{ "words": [...] }`, 1 to 1,000 at a time. Each returns the whole list: `{ words }`. |
| `GET`, `POST`, `DELETE /tags/:tag/blocked-words` | The hashtag's moderators, and admins | The same, for the hashtag's list: `{ tag, words }`. |
| `GET /tags/:tag/moderators` | Anyone | `{ tag, moderators: [{ userId, username, since }] }` |
| `PUT /tags/:tag/moderators/:userId` | Admins | Appoints a moderator: `201` with `{ tag, userId, since, alreadyModerator: false }`, or `200` with `alreadyModerator: true` if they already were. |
| `DELETE /tags/:tag/moderators/:userId` | Admins | `{ tag, userId, wasModerator }` |
| `GET /tags/:tag/muted` | The hashtag's moderators, and admins | Users muted on the hashtag, most recently muted first: `{ tag, muted: [{ userId, username, mutedAt }], nextCursor }`. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `PUT /tags/:tag/muted/:userId` | The hashtag's moderators, and admins | Mutes a user on the hashtag: `201` with `{ tag, userId, mutedAt, alreadyMuted: false }`, or `200` with `alreadyMuted: true`. |
| `DELETE /tags/:tag/muted/:userId` | The hashtag's moderators, and admins | `{ tag, userId, wasMuted }` |
| `PUT /content/:contentId/tags/:tag` | The hashtag's moderators, and admins | Approves the content under the hashtag: `201` with `{ contentId, tag, moderated: true, alreadyApproved: false }`, or `200` with `alreadyApproved: true`. |
| `DELETE /content/:contentId/tags/:tag` | The hashtag's moderators, and admins | Removes the hashtag from the content (below). With `{ "mute": true }`, it also mutes the content's publisher on the hashtag. |
| `GET /moderation/queue` | Server moderators, and admins | The posts and comments in the moderation queue, longest waiting first: `{ queue: [...], nextCursor }`. Each has a `kind`. A `"post"` is a feed record (without `moderated`), with `text` (the whole text or caption); a `"comment"` is a [comment](#comments) as its post's list gives it. Both have `trustScore` and `queuedAt`. Takes `limit` (50 by default, at most 100) and `cursor`. |
| `POST /moderation/queue/:contentId/accept` | Server moderators, and admins | Publishes the post: `{ contentId, status: "published", tags }`. |
| `POST /moderation/queue/:contentId/reject` | Server moderators, and admins | Takes the post down: `202` with `{ contentId, status: "pending_deletion", requestedAt }`. |
| `POST /moderation/queue/:contentId/comments/:commentId/accept` | Server moderators, and admins | Publishes the comment: `{ contentId, commentId, status: "published" }`. |
| `POST /moderation/queue/:contentId/comments/:commentId/reject` | Server moderators, and admins | Deletes the comment: `{ contentId, commentId, status: "deleted" }`. |
| `GET /moderation/reports` | Server moderators, and admins | The posts and comments in the report queue, longest reported first: `{ queue: [...], nextCursor }`. Each has a `kind`, and is a post or a comment as in the moderation queue, with `reports` (how many reports wait for a decision) and `reportedAt` (the first of them). Takes `limit` (50 by default, at most 100) and `cursor`. |
| `GET /moderation/reports/:contentId` | Server moderators, and admins | A post's reports that wait for a decision, most recent first: `{ contentId, reports: [{ userId, username, reason, reportedAt }], nextCursor }`, without `reason` where none was given. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `POST /moderation/reports/:contentId/accept` | Server moderators, and admins | Leaves the post as it is, and settles its reports: `{ contentId, status: "accepted", reports }`, with how many it settled. |
| `POST /moderation/reports/:contentId/delete` | Server moderators, and admins | Takes the post down: `202` with `{ contentId, status: "pending_deletion", requestedAt }`. |
| `GET /moderation/reports/:contentId/comments/:commentId` | Server moderators, and admins | A comment's reports that wait for a decision, as a post's: `{ contentId, commentId, reports: [...], nextCursor }`. |
| `POST /moderation/reports/:contentId/comments/:commentId/accept` | Server moderators, and admins | Leaves the comment as it is, and settles its reports: `{ contentId, commentId, status: "accepted", reports }`. |
| `POST /moderation/reports/:contentId/comments/:commentId/delete` | Server moderators, and admins | Deletes the comment: `{ contentId, commentId, status: "deleted" }`. |

An item of either queue looks like this, a post and then a comment (of the moderation queue here):

```json
{ "queue": [
  { "kind": "post", "contentId": "...", "publisher": { "userId": "...", "username": "alice" },
    "mimeType": "text/plain", "aiGenerated": false, "comments": true,
    "preview": { "kind": "text", "text": "Free things inside #news" }, "tags": ["news"], "likes": 0,
    "createdAt": "2026-11-10T14:02:00.000Z", "updatedAt": "2026-11-10T14:02:00.000Z",
    "text": "Free things inside #news", "trustScore": 40, "queuedAt": "2026-11-10T14:02:00.000Z" },
  { "kind": "comment", "commentId": "...", "contentId": "...", "author": { "userId": "...", "username": "bob" },
    "text": "Buy mine instead", "createdAt": "2026-11-10T14:05:00.000Z",
    "trustScore": 40, "queuedAt": "2026-11-10T14:05:00.000Z" }
], "nextCursor": null }
```

Someone without the role gets `403`. A user or content that doesn't exist gets `404`, and so does accepting or rejecting content or a comment that isn't in the moderation queue, or accepting or deleting one that isn't in the report queue. An entry with no letters or digits, or too long, gets `400`, and adding past 10,000 entries gets `409`.

**Removing a hashtag from content** is recorded at once. The compactor's next run then writes the content's meta file and summary again without the hashtag, and takes the content out of the hashtag's index, which is when that hashtag's feeds stop returning it, and `GET /content` and the content's records under its other hashtags stop listing the hashtag. Its bytes, text, preview and AI flag stay as they are. The response is `{ contentId, tag, tags, muted }`, with the hashtags the content is left with in `tags`.
- The removal is recorded, and stays: the publisher's updates of that content don't get the hashtag back. Their other content still can. To stop that too, mute them on the hashtag (`{ "mute": true }`), or block the words that make the content unwelcome there.
- A hashtag the content doesn't have gets `404`, and so does removing one a second time, or approving the content under a hashtag that was removed from it. Content in the moderation queue gets `404` too: it's for server moderators and admins to decide on first.
- If it's the content's last hashtag, the content is taken down instead, as `DELETE /content` does. The response is then `202`, with `tags: []`, `status: "pending_deletion"` and `requestedAt`.

**Rules apply from when they're set.** A blocked word, a mute or a trust score threshold applies to the posts and updates written after it's set. Content already published keeps its hashtags until its next update: to take it down, delete it, or remove its hashtags.

## The CLI download

An instance ships its own [CLI](CLI.md), for anyone to download. None of these endpoints needs a key.

| Endpoint | What it returns |
| --- | --- |
| `GET /cli` | `{ version, build, sha256, size, url, install: { sh, powershell } }`: the CLI the server ships, where to download it, and the two install commands. |
| `GET /cli/evieverse.mjs` | The CLI itself: run it with `node evieverse.mjs`. |
| `GET /cli/install.sh`, `GET /cli/install.ps1` | The install scripts. |

The scripts and `url` use `PUBLIC_BASE_URL` as the server's address, or else the address the request came to. A server run from source (`npm run dev`) has no CLI built, and answers these with `404`: `npm run build` builds both.

The CLI names its build in an `X-Evieverse-CLI` header on every request, and a server that ships another build answers `426` until the CLI has updated itself ([CLI.md](CLI.md#updates)). No other client sends the header, so no other client gets a `426`.
