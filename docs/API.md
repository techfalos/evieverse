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
| [`GET /challenges/:challengeId/audio`](#get-challengeschallengeidaudio) | Anyone who has the challenge | A [challenge](#challenges)'s characters read out, for people who can't read its image. |
| [`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid) | Anyone | A user's public profile and roles. |
| [`PATCH /users/:userId`](#get-usersuserid-and-patch-usersuserid) | The user | Changes the user's username, their language, whether they take part in messages between users, whether they show whom they follow and who follows them, or their profile's bio and links. |
| [`PUT /users/:userId/avatar`](#the-avatar) | The user | Sets the user's avatar, made of the image the request sends. |
| [`DELETE /users/:userId/avatar`](#the-avatar) | The user | Takes the user's avatar away. |
| [`GET /users/:userId/avatar`](#the-avatar) | Anyone | A user's avatar. |
| [`GET /users/:userId/posts`](#get-usersuseridposts) | Anyone | A user's posts, newest first, a page at a time, with the posts they pinned. |
| [`PUT /users/:userId/pinned/:contentId`](#pinned-posts) | The user | Pins one of the user's posts to their profile. |
| [`DELETE /users/:userId/pinned/:contentId`](#pinned-posts) | The user | Unpins it. |
| [`POST /users/:userId/key`](#post-usersuseridkey) | The user, or an admin | Replaces the user's API key with a new one, and revokes the old one. |
| [`DELETE /users/:userId`](#delete-usersuserid) | The user, or an admin | Deletes an account, and the posts it published. |
| [`GET /users/:userId/export`](#get-usersuseridexport) | The user | The user's export of their own data: everything the instance holds of them, a page at a time. |
| [`GET /whoami`](#get-whoami) | Any user | The account a key belongs to, its roles, whether it's banned, its language and its settings. |
| [`GET /languages`](#get-languages) | Anyone | The languages the instance answers in. |
| [`POST /store`](#post-store) | Any user | Creates a post, or updates one of the user's own. |
| [`POST /uploads`](#post-uploads) | Any user | Gives a link for sending a large file straight to the content store. |
| [`GET /content/:contentId`](#get-contentcontentid) | Anyone | A post: its credit, text, hashtags and likes. |
| [`GET /content/:contentId/raw`](#get-contentcontentid) | Anyone | A post's bytes. |
| [`GET /content/:contentId/raw/:n`](#get-contentcontentid) | Anyone | Image number `n` of an image post of several images (an album). |
| [`GET /content/:contentId/video/:videoId/:file`](#videos) | Anyone | A file of a post's processed video: its poster, or a playlist or segment of its adaptive stream. |
| [`DELETE /content/:contentId`](#delete-contentcontentid) | The publisher, or an admin | Deletes a post. |
| [`POST /repost`](#post-repost) | Any user | Reposts someone else's post: gives it more hashtags, under which it shows as a new post, as it does to the reposter's followers. |
| [`POST /repost/refresh`](#refreshing-a-repost) | Any user | Brings the instance's entry for a post on another server up to what that server now signs of it: its summary as it is now, or that it's gone. |
| [`GET /content/:contentId/attestation`](#attestations) | Anyone | A post as the instance signs it, for a repost of it on another server. Where there's no post, a signed word of that. |
| [`GET /repost/keys`](#attestations) | Anyone | The public keys the instance signs its posts' attestations with. |
| [`POST /like`](#post-like) | Any user | Likes a post, or a comment on one. |
| [`DELETE /like`](#delete-like) | Any user | Takes back the user's like of a post, or of a comment on one. |
| [`POST /report`](#post-report) | Any user | Reports a post, or a comment on one, to the server's moderators. |
| [`GET /content/:contentId/comments`](#reading-comments) | Anyone | The comments on a post, a page at a time. |
| [`GET /content/:contentId/comments/:commentId/replies`](#reading-comments) | Anyone | The replies to a comment, a page at a time. |
| [`GET /content/:contentId/comments/:commentId`](#reading-comments) | Anyone | One comment. |
| [`GET /content/:contentId/comments/:commentId/raw`](#reading-comments) | Anyone | The bytes of a comment's image or video. |
| [`POST /content/:contentId/comments`](#post-contentcontentidcomments) | Any user | Comments on a post that takes comments, or replies to a comment on it. |
| [`PATCH /content/:contentId/comments/:commentId`](#patch-contentcontentidcommentscommentid) | The comment's author | Edits a comment's text. |
| [`DELETE /content/:contentId/comments/:commentId`](#delete-contentcontentidcommentscommentid) | The comment's author, the post's publisher, or an admin | Deletes a comment. |
| [`PUT /users/:userId/following/:followeeId`](#following) | The user | Follows a user. |
| [`DELETE /users/:userId/following/:followeeId`](#following) | The user | Stops following a user. |
| [`GET /users/:userId/following`](#following) | The user, or anyone if the user shows the list | Lists whom a user follows. |
| [`GET /users/:userId/followers`](#following) | The user, or anyone if the user shows the list | Lists who follows a user. |
| [`GET /users/:userId/inbox`](#reading-the-inbox) | The user | The user's inbox: the messages users sent them, and the server's notices about their posts and mutes, and of the posts and comments that mention them. |
| [`POST /users/:userId/inbox/read`](#reading-the-inbox) | The user | Marks what's in the inbox as read. |
| [`DELETE /users/:userId/inbox/:messageId`](#reading-the-inbox) | The user | Deletes a message or a notice from the inbox. |
| [`POST /messages`](#post-messages) | Any user | Sends another user a message. |
| [`PUT /users/:userId/blocked/:blockedId`](#blocks) | The user | Blocks a user: no message goes between the two, neither follows the other, and the blocked user can't comment on the user's posts. |
| [`DELETE /users/:userId/blocked/:blockedId`](#blocks) | The user | Ends a block. |
| [`GET /users/:userId/blocked`](#blocks) | The user | Lists whom the user blocks. |
| [`GET /feed`](#get-feed) | Anyone | A feed of one or more hashtags. |
| [`GET /feed/following`](#get-feedfollowing) | The user, or anyone if the user shows whom they follow | The posts of the users a user follows. |
| [`GET /tagging`](#get-tagging) | Anyone | Which hashtags a post can have: any, or the ones the instance lists. |
| [`GET /tags`](#get-tags) | Anyone | Lists the hashtags posts have used, most recently active first. |
| [`GET /search`](#search) | Anyone | Finds users by the start of their username, or posts by the words of their text and by their hashtags. |
| [`GET /monetization/ads/:adId/click`](#get-monetizationadsadidclick) | Anyone | An ad's link: counts a click on the ad, and redirects to where the ad leads. |
| [`GET /monetization/ads/:adId/image`](#get-monetizationadsadidimage) | Anyone | An image ad's image. |
| [`POST /monetization/ads`](#keeping-the-ads) | Admins | Creates an ad. |
| [`GET /monetization/ads`](#keeping-the-ads) | Admins | Lists the ads, with how many clicks each has had. |
| [`GET /monetization/ads/:adId`](#keeping-the-ads) | Admins | One ad. |
| [`PATCH /monetization/ads/:adId`](#keeping-the-ads) | Admins | Changes an ad. |
| [`DELETE /monetization/ads/:adId`](#keeping-the-ads) | Admins | Deletes an ad, and its image. |
| [`GET /rules`](#get-rules) | Anyone | The server's rules, the email address to write to for support, and its modification disclosure: whether it runs a release of Evieverse or a modified version. |
| [`POST /rules`](#keeping-the-rules) | Admins | Adds a rule. |
| [`PATCH /rules/:ruleId`](#keeping-the-rules) | Admins | Changes a rule's text, or its place among the others. |
| [`DELETE /rules/:ruleId`](#keeping-the-rules) | Admins | Removes a rule. |
| [`GET /tags/:tag/rules`](#a-hashtags-rules) | Anyone | A hashtag's own rules, which its moderators set. |
| [`POST /tags/:tag/rules`](#a-hashtags-rules) | The hashtag's moderators, server moderators, and admins | Adds a rule to the hashtag's. |
| [`PATCH /tags/:tag/rules/:ruleId`](#a-hashtags-rules) | The hashtag's moderators, server moderators, and admins | Changes one of the hashtag's rules, or its place among the others. |
| [`DELETE /tags/:tag/rules/:ruleId`](#a-hashtags-rules) | The hashtag's moderators, server moderators, and admins | Removes one of the hashtag's rules. |
| [`POST /tags/:tag/claim`](#claiming-a-hashtag) | Any user, where publishers choose their posts' hashtags | Claims a hashtag that has no moderator, to moderate it. |
| [`DELETE /tags/:tag/claim`](#claiming-a-hashtag) | The claim's user, server moderators, and admins | Withdraws a claim that waits, or refuses it. |
| [The moderation endpoints](#moderation-endpoints) | Mostly admins and moderators | Roles, bans, blocked words, mutes, a hashtag's moderators and the claims to hashtags, the two kinds of moderation queue, and the report queue. |
| [`GET /cli` and the files under it](#the-cli-download) | Anyone | The CLI the instance ships. |
| `GET /health` | Anyone | `{ "ok": true }`, for a load balancer to check. |

## Conventions

- **Base URL.** An instance's own address, such as `https://api.example.com`. The examples here use `localhost:3000`, where a server run from this repo listens.
- **Bodies.** Requests and responses are JSON. The exceptions are files: `POST /store`, `POST /content/:contentId/comments` and `PUT /users/:userId/avatar` also take `multipart/form-data`, the two `/raw` endpoints return a post's bytes, and those of a comment's image or video, `GET /users/:userId/avatar` returns an [avatar](#the-avatar)'s, `/content/:contentId/video/…` returns the files of a [processed video](#videos), and [`GET /challenges/:challengeId/audio`](#get-challengeschallengeidaudio) returns a WAV.
- **Time.** Every timestamp is UTC, as ISO-8601 with a `Z` suffix: `2026-11-10T14:02:00.000Z`.
- **Ids.** Users, content and comments are identified by UUIDs.
- **Pages.** An endpoint that returns a page at a time gives a `nextCursor` with it. Send that as `cursor` to get the next page. It's `null` when there are no more.

### Authentication

Write endpoints authenticate with `userId` and `apiKey`, which [`POST /register`](#post-register) returns. Send them in the JSON body or form fields, or as the headers `Authorization: Bearer <apiKey>` and `X-User-Id: <userId>`. A missing or wrong key gets `401`. Reading hashtag feeds, content, profiles and hashtags needs no key, nor does a [search](#search), and neither does a [follow list](#following) or a [following feed](#get-feedfollowing) whose user shows whom they follow. A `GET` has no body, so one that needs a key takes it from the headers.

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
| `404` | There's no such user, content or comment. Content set for deletion, or held in the [moderation queue](#the-moderation-queue), counts as not there, and so do the comments of a post that doesn't take them, and the [audio](#get-challengeschallengeidaudio) of a challenge that was answered or has expired. |
| `409` | The request conflicts with what's there: a username that's taken, an update of content set for deletion, a follow past the limit, a [pinned post](#pinned-posts) past the limit. |
| `410` | A feed's cursor was issued by an earlier release of the server: start the feed over. |
| `413` | The file is larger than the instance accepts. |
| `422` | [Moderation](#moderation) refused the post, the comment, or what a user put on their [profile](#a-users-profile). |
| `426` | For the CLI only: the instance ships another build of it ([CLI.md](CLI.md#for-everyone)). |
| `428` | A registration needs a [challenge](#challenges) solved. |
| `429` | Too many requests: registrations, [feeds](#get-feed) or the [other reads that need no key](#limits-on-reads-that-need-no-key) from one address, [posts in a minute](#limits-on-posts-and-comments), upload links in a minute, messages in a minute, [comments in a minute](#limits-on-posts-and-comments), or reports in an hour. |
| `501` | The instance's content store can't sign upload links ([`POST /uploads`](#post-uploads)). |
| `503` | An unfollow was made, but the following feed couldn't be updated: send it again. Also a [feed](#get-feed) asked for while the instance is answering as many as it does at a time: `Retry-After` says when to try again. |

## Challenges

To keep robots out, a registration must show that a person is behind it by solving a challenge, unless an admin sends it. Nothing else needs one: posts and comments are held to [a limit a minute](#limits-on-posts-and-comments) alone. A registration without a solution is answered with `428`, and nothing is done. The response holds the challenge:

```json
{ "error": "solve the challenge to register",
  "challenge": { "id": "8f0c2d1e-…", "image": "data:image/png;base64,iVBORw0KGgo…",
                 "audio": "https://api.example.com/challenges/8f0c2d1e-…/audio",
                 "expiresAt": "2026-11-10T14:02:00.000Z", "expiresInSeconds": 120,
                 "proofOfWork": { "algorithm": "SHA-256", "prefix": "8f0c2d1e-…:", "bits": 18 } } }
```

- `image` is a PNG of six characters, for a person to read.
- `audio` is a link to the same six characters read out, for a person who can't read the image ([below](#get-challengeschallengeidaudio)). A client should offer both: an image with a player for the audio beside it.

To solve it, send the same request again within 120 seconds (`CHALLENGE_TTL_SECONDS`), with three more fields:
- `challengeId`: the challenge's `id`.
- `challengeAnswer`: the six characters of the image, which are the ones the audio says, typed by a person. Case and spaces don't matter.
- `challengeNonce`: the proof of work, which the client's software finds while the person reads or listens. It's any string that makes the SHA-256 of `prefix + nonce` (UTF-8) start with `bits` zero bits. Counting up from 0 finds one after about 2^`bits` hashes on average: at 18 bits, about 1.5 seconds in a desktop browser, and longer on slower devices.

Rules:
- **One answer per challenge.** Each challenge can be answered once, right or wrong. A wrong, late or incomplete answer gets `428` again, with a new challenge and an `error` that says what was wrong.
- **Not too fast.** An answer sent less than `CHALLENGE_MIN_SOLVE_MS` (2 seconds) after the challenge was issued is refused, since no person reads or listens, and types it, that fast.
- **None for an admin who registers a user.** A registration sent with an admin's credentials goes through without one ([`POST /register`](#post-register)).

The server draws the image itself, with no third-party service. It's a PNG, so a robot can only read it from its pixels, and it's drawn to make that hard:
- the six characters come from an alphabet with no look-alikes, and are drawn as strokes rather than from a font;
- each character is scaled, rotated and sheared, and overlaps its neighbours;
- curves as thick as the characters' strokes run through them;
- the whole image is bent by a wave, a band of it is inverted, and it's covered in noise.

The proof of work makes every attempt cost CPU time, so guessing at scale is slow.

### `GET /challenges/:challengeId/audio`

Returns a challenge's six characters read out, one after another: what the challenge's `audio` links to. It's for people who can't read the image, and the answer is the same either way.

```bash
curl -o challenge.wav https://api.example.com/challenges/8f0c2d1e-…/audio
```

- **A WAV** (`audio/wav`: 16-bit mono PCM at 16 kHz), about 6 seconds and 180 KB, which the major browsers play. An `<audio>` element plays the link as it is:

  ```html
  <audio controls preload="none" src="https://api.example.com/challenges/8f0c2d1e-…/audio"></audio>
  ```
- **No key.** Whoever has the challenge has its id, and nobody else does, so the request takes no credentials.
- **As often as it takes.** Listening doesn't answer the challenge or use it up, and it sounds the same every time. A `Range` header is answered with that part of it (`206`), or `416` for a part it doesn't have.
- **Only while the challenge can be answered.** Once it has been answered, right or wrong, or is past its `expiresAt`, the link returns `404`. So does an id that was never a challenge's; one that isn't a UUID returns `400`.
- **In the challenge's language.** The characters are said in the [language](#get-languages) the `428` was answered in, whatever the headers of this request say. A language the instance has no voice for is said in its default language's voice, or else in English.
- **Never cached.** The response is `Cache-Control: no-store`.

The voice is a speech synthesiser's, and each challenge is spoken a little differently: the characters faster or slower, higher or lower, with pauses of uneven length and a light hiss. That's kept light so people can make the characters out, which means the audio keeps robots out less well than the image does. A robot that listens still has to do the proof of work, gets one answer per challenge, and is held to the same limit on registrations from one address.

## Limits on posts and comments

No challenge is asked for a post or a comment. What holds them is a limit a minute, for each user.

**Nobody can post more than 3 times in any minute** (`POST_RATE_LIMIT_PER_MINUTE`). A post past that is refused with `429`, and nothing is stored. The response says when the oldest of those posts is a minute old, so the next one can go through. That's in a `Retry-After` header and in the body:

```json
{ "error": "you can post at most 3 times a minute; try again in 40 seconds", "retryAfterSeconds": 40 }
```

- **New content, updates and reposts are posts.** Storing the same content again unchanged isn't.
- **Only posts that are stored count.** One that's refused for any other reason, or that fails, doesn't.
- **The minute slides.** A post goes through whenever fewer than 3 of your posts are less than a minute old, so no burst across the turn of a minute gets more through.
- **Posts claim their place atomically,** in Redis: of several sent at once, no more get through than the limit allows.

**Nobody can comment more than 10 times in any minute** (`COMMENTS_PER_MINUTE`). Comments go by the same rule, with a number of their own: a comment past it is refused with `429`, with when to try again in a `Retry-After` header and in the body:

```json
{ "error": "too many comments; try again in 12 seconds", "retryAfterSeconds": 12 }
```

- **An [edit](#patch-contentcontentidcommentscommentid) of a comment counts as a comment,** as an update of a post counts as a post.
- **Only comments that were published or held count.** One that's refused, or that fails, doesn't.
- **Posts and comments are counted apart.** A comment doesn't count towards the posts a user can send in a minute, nor a post towards the comments.

## Accounts

### `POST /register`

```json
{ "username": "Alice", "language": "es" }
```

The first request is answered with a [challenge](#challenges). The same request sent again with its solution returns `201` with `{ userId, username, language, apiKey, note }`. The key is shown only once, which `note` says. This endpoint is rate limited per IP (`REGISTER_RATE_LIMIT_PER_HOUR`, 10 an hour), and every attempt counts, so registering uses at least two.
- `userId` (a UUID) is the user's identity everywhere.
- `username` is a display name of 1 to 64 characters, and must be unique (exact match). A name already in use returns `409`, before any challenge. It's the credit shown on everything the user publishes.
- `language` is optional: the code of any of the instance's [languages](#get-languages), which [`GET /languages`](#get-languages) lists. The instance answers the user in it from this request on, challenge included. Without it, the user registers in the language the request is answered in: the one its `Accept-Language` header asks for, or the instance's default. A code that isn't one of the instance's returns `400`, with the ones that are. The response's `language` is the one the user got.

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
- A request with credentials is answered in [their user's language](#get-languages), so a user registered without a `language` gets the admin's, not the one `Accept-Language` asks for.

### `GET /users/:userId` and `PATCH /users/:userId`

`GET` returns a public profile: `{ userId, username, createdAt, banned, bio, links, avatarUrl, pinnedContentIds, admin, moderator, moderates }`.

```json
{ "userId": "...", "username": "alice", "createdAt": "2026-10-02T09:15:00.000Z",
  "banned": false,
  "bio": "Trams, mostly. **Lisbon** when I can.",
  "links": ["https://blog.example/alice", "https://social.example/@alice"],
  "avatarUrl": "/users/.../avatar?v=...",
  "pinnedContentIds": ["..."],
  "admin": false, "moderator": false, "moderates": [] }
```

- `createdAt` is when the account was registered.
- `banned` is whether the account is [banned](#bans). A banned user's profile says so and shows nothing they put on it: `bio` is `null`, `links` and `pinnedContentIds` are empty and `avatarUrl` is `null`, until the ban ends.
- `bio`, `links`, `avatarUrl` and `pinnedContentIds` are the user's [profile](#a-users-profile): what they say of themselves, where else they're found, where their avatar is read, and the posts they pinned. `bio` and `avatarUrl` are `null`, and the two lists empty, for a user who set none.
- `admin` is whether the user is an admin, `moderator` whether they're a server moderator, and `moderates` lists the hashtags they're a moderator of, as [moderation](#moderation) describes.
- A user's language isn't part of their public profile, and neither are their settings: whether they take messages, and whether they show whom they follow and who follows them.

`PATCH` (authenticated, own profile only) updates `username`, `language`, `messages`, `showFollowing`, `showFollowers`, `bio`, `links`, or any of them at once, and returns `{ userId, username, language, messages, showFollowing, showFollowers, bio, links, avatarUrl }` as they now are. A request with none of them gets `400`.
- `bio` and `links` are the user's [profile](#a-users-profile), which says what each can be.
- `messages` is whether the user takes part in [messages between users](#post-messages): `true` (as every account starts) or `false`. With it off, the user is sent no messages and sends none. The server's [notices](#notices) still reach their inbox.
- `showFollowing` is whether anyone can list whom the user [follows](#following), and `showFollowers` whether anyone can list who follows them: `false` (as every account starts) or `true`, each on its own. The user can list both themselves either way. `showFollowing` also decides whether anyone can read the user's [following feed](#get-feedfollowing), which shows whose posts they follow.
- `username` must still be unique: `409` if it's taken. Feeds show the new name on all of the user's content at once: they look the credit up in Redis when they render.
- `language` is the code of any of the instance's [languages](#get-languages): `400` if it isn't one of them. The instance answers the user in it from this response on.
- A request that changes several changes them all or none.

```bash
curl -X PATCH localhost:3000/users/$USER_ID -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"apiKey\":\"$KEY\",\"language\":\"es\"}"
```

### A user's profile

Beside their name, a user's profile has what they chose to say of themselves: a bio, links, an avatar and the posts they pinned. Each is the user's own to set and to take away, with their key, and nobody else's: anyone else gets `403`, an admin included. Anyone reads them, with [`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid), and the user's posts with [`GET /users/:userId/posts`](#get-usersuseridposts).

The bio and the links are fields of [`PATCH /users/:userId`](#get-usersuserid-and-patch-usersuserid):

| Field | What it is |
| --- | --- |
| `bio` | A text of up to 500 characters, in the [format](TEXT_EDITORS.md) a post's text is in. It's stored as it was sent, without the spaces around it. It mentions nobody: an `@alice` in it is the characters. `null` or an empty string takes it away. |
| `links` | Up to 10 addresses, `http` or `https`, each of 2,048 characters at most. The list sent is all of them: it takes the place of the one there was. They're kept in the order they were sent, and one sent twice is there once. `null` or an empty list takes them away. |

```bash
curl -X PATCH localhost:3000/users/$USER_ID -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"apiKey\":\"$KEY\",\"bio\":\"Trams, mostly.\",\"links\":[\"https://blog.example/alice\"]}"
```

**A profile is moderated as a post is.** A bio, links and an avatar go through the instance's [trust plugins](#moderation) before they're saved. One that isn't trusted is refused with `422`, and nothing of the request is saved, whatever else it changed:

```json
{ "error": "it contains a word or phrase this server doesn't allow, so it wasn't saved" }
```

A profile doesn't wait in a moderation queue: what a post would be held for is refused too. Taking something away isn't checked.

**A [banned](#bans) user sets no bio, links or avatar** (`403`), and can still take theirs away, and pin and unpin posts. While the ban lasts, nobody is shown what they put on their profile: [`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid) says `banned: true` and gives no bio, no links, no avatar and no pinned post, the avatar is `404`, and the list of their posts is empty. It's all kept, and shown again when the ban ends. The user reads their own in the answer to their `PATCH`, and in their [export](#get-usersuseridexport).

When an account is [deleted](#delete-usersuserid), its profile goes with it, avatar included.

#### The avatar

`PUT /users/:userId/avatar` (authenticated, own profile only) sets the user's avatar. The image is sent as [`POST /store`](#post-store) takes a file: as the file part `content` of a multipart request, or in JSON as a base64 string in `content` (a JSON request can be at most 16 MB), with an optional `filename`.

```bash
curl -X PUT localhost:3000/users/$USER_ID/avatar -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F content=@me.jpg
```

```json
{ "userId": "...", "avatarUrl": "/users/.../avatar?v=..." }
```

- **It's a JPEG, PNG, GIF or WebP image,** told by its bytes, whatever it was sent as: `400` for anything else. It can be at most 5 MiB, or `MAX_UPLOAD_BYTES` where that's less: `413` past that.
- **Every avatar is the same size and type.** The server makes the avatar of the image: a square of 400 pixels a side, as a WebP file, whatever was sent. The image is turned the way it shows, cut to the largest square about its middle, and brought to the size, down for a large image and up for a small one. What was transparent stays so, and an animated image gives its first frame. None of the image's metadata is in it. An image whose pixels can't be read gets `400`.
- **Setting another replaces it.** The one before is deleted.
- **It's checked first,** as [above](#a-users-profile): `422` for one the instance doesn't trust, and nothing is stored. The image is checked as it was sent.

`DELETE /users/:userId/avatar` (authenticated, own profile only) takes it away, and returns `{ userId, avatarUrl: null, hadAvatar }`. `hadAvatar` is `false` if there was none, which changes nothing.

`GET /users/:userId/avatar` returns the avatar, to anyone: its bytes, as `image/webp`, or a redirect to them on stores that support presigned URLs, as [`/raw`](#get-contentcontentid) does for a post's.

- **`avatarUrl` is this address, with the avatar's id as `v`:** `/users/<userId>/avatar?v=<avatarId>`. Another avatar has another `v`, so what that address answers may be kept for a day (`Cache-Control: public, max-age=86400`).
- **Without `v`, it's whatever avatar the user has now,** kept for five minutes. A client that knows only a user's id shows their avatar with it. So does an address with the `v` of an avatar the user had before.
- **`404`** for a user who has no avatar, for one who isn't there, and for one who is [banned](#bans): the `error` says which.
- **It goes out with the user's credit on their posts,** where a post is read on its own or in the list of its publisher's posts: `publisher.avatarUrl` in [`GET /content/:contentId`](#get-contentcontentid) and in [`GET /users/:userId/posts`](#get-usersuseridposts). Feeds and search results have the name alone: read the avatar there by the address without `v`.
- One address can ask for 300 avatars a minute (`AVATAR_RATE_LIMIT_PER_MINUTE`), then gets `429` ([below](#limits-on-reads-that-need-no-key)).

#### `GET /users/:userId/posts`

Returns a user's posts, for their profile: all of them, newest first, a page at a time. It needs no key.

```bash
curl "localhost:3000/users/$USER_ID/posts?limit=20"
```

```json
{ "userId": "...", "banned": false,
  "pinned": [ { "contentId": "...", "publisher": { "userId": "...", "username": "alice", "avatarUrl": "/users/.../avatar?v=..." }, "…": "…" } ],
  "posts": [ { "contentId": "...", "publisher": { "userId": "...", "username": "alice", "avatarUrl": "/users/.../avatar?v=..." }, "…": "…" } ],
  "nextCursor": "WzE3OTQ…" }
```

It takes:
- `limit`: the most posts in the page, 20 by default, from 1 to 50.
- `cursor`: the previous page's `nextCursor`. It's `null` on the last page.

What it returns:
- **`posts` is the page.** Each post is a record as a [feed](#get-feed) gives one, with all of its likes, and without `moderated`, which is a hashtag's. Its `publisher` also has `avatarUrl`, if the user has an avatar.
- **`pinned` is the posts the user [pinned](#pinned-posts),** the one pinned last first, as records like the others, and `[]` if they pinned none. Only the first page has it. A pinned post keeps its place among `posts` too.
- **Only what anyone can read is listed:** no post set for deletion, none that waits in the [moderation queue](#the-moderation-queue), and no repost of a post on another server that is [gone there](#refreshing-a-repost).
- **The user's own posts,** not what they [reposted](#post-repost), which are other users' posts.
- **A new post is listed once the [compactor](APP.md#8-the-compactor) has written it,** which is when it's in feeds: seconds.
- **`banned` is whether the user is [banned](#bans).** For a banned user it's `true` and the list is empty, on every page: `posts` is `[]`, `pinned` is `[]` and `nextCursor` is `null`. Their posts are still in feeds, and read by their ids.

| Status | What happened |
| --- | --- |
| `200` | A page of the user's posts. |
| `400` | The `cursor` isn't one of this list's, or `limit` isn't from 1 to 50. |
| `404` | There's no such user, or their account is deleted. |
| `429` | The address asked for 120 pages in the last minute (`PROFILE_POSTS_RATE_LIMIT_PER_MINUTE`, [below](#limits-on-reads-that-need-no-key)). |

#### Pinned posts

`PUT /users/:userId/pinned/:contentId` (authenticated, own profile only) pins one of the user's own posts to their profile. It takes no fields but the [credentials](#authentication), and returns `201` with `{ userId, contentId, pinnedAt, alreadyPinned: false }`.

```bash
curl -X PUT localhost:3000/users/$USER_ID/pinned/$CONTENT_ID -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

- **A profile has 5 pinned posts at most.** One more gets `409`, until another is unpinned.
- **Pinning a post that's pinned changes nothing:** `200`, with `alreadyPinned: true` and the `pinnedAt` it was first pinned at. It keeps its place among the pinned posts.
- **Only the user's own posts:** `403` for anyone else's, and `404` for a post that isn't there, or is set for deletion.
- **The profile names them** in `pinnedContentIds`, the one pinned last first, and the first page of the [user's posts](#get-usersuseridposts) gives them as records, in `pinned`, in the same order.
- **A pinned post is shown as one only while anyone can read it.** One that waits in the moderation queue can be pinned, and is among the pinned posts once it's published. It counts towards the 5 meanwhile.
- **Deleting a post unpins it.**

`DELETE /users/:userId/pinned/:contentId` (authenticated, own profile only) unpins it, and returns `{ userId, contentId, wasPinned }`. `wasPinned` is `false` for a post that wasn't pinned, which changes nothing.

### `POST /users/:userId/key`

Authenticated: the account's own user, or an [admin](#moderation). Replaces the account's API key: it revokes the key the account had and returns a new one, as `201` with `{ userId, apiKey, note }`. Use it when a key may have leaked, or to change keys as a routine, and as an admin for a user who lost theirs. It takes no fields but the [credentials](#authentication).

```bash
curl -X POST localhost:3000/users/$USER_ID/key -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

- The old key stops working at once, everywhere: every later request with it gets `401`. Every client that held it needs the new one.
- The new key is the account's only key. Any other key the account had is revoked with the one presented.
- The new key is shown only once, as at registration, which `note` says. If the response is lost on its way, the account has a key nobody knows, and no endpoint gets it back.
- Nothing else about the account changes: its `userId`, its name, its roles, its posts and what it follows stay as they are.
- An admin can replace another user's key, another admin's included. Every key that user had stops working, and the new one is returned to the admin, once, to pass on. The admin's own key stays as it is. A user who doesn't exist gets `404`.
- Anyone else's request for another user's key gets `403`.
- Of two requests sent at once with the same key, one gets the new key and the other `401`.
- Whoever holds a key can replace it, so this takes an account back from someone who copied its key only if its owner gets there first. After that, an admin's replacement is the way back.
- The admin account of a [Terraform deployment](DEPLOY.md#the-admin-account) gets its key from the deployment. A key replaced here lasts: later deploys leave it in place, and the deployment's key stays revoked. The deployment still holds the old key, though, so its `admin_api_key` output no longer works, and its next apply writes that key back to the profile file.

The [CLI](CLI.md) does this with `evieverse key rotate`, and saves the new key in its profile. An admin replaces another user's key with `evieverse users rotate-key <userId>`, which prints the new key.

### `DELETE /users/:userId`

Authenticated. Deletes the account, for good: the user's own, or any account for an admin. It takes no fields but the [credentials](#authentication). Anyone else's account gets `403`, and a user who isn't there `404`.

```bash
curl -X DELETE localhost:3000/users/$USER_ID -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

The response says whether the account is gone yet:
- `200` with `{ userId, status: "deleted" }`: the account had no posts, and is gone.
- `202` with `{ userId, status: "pending_deletion", requestedAt }`: the account has posts. They're set for deletion as [`DELETE /content/:contentId`](#delete-contentcontentid) sets one, and the account goes with the last of them, when the [compactor](APP.md) next runs. A repeat of the request gets the same answer, with the same `requestedAt`.

From the response on, as far as anyone can tell the account is gone, whichever it is:
- Its keys stop working (`401`), and it isn't a user to look up (`404`), follow, message, block, ban or appoint to a role. Its [profile](#a-users-profile) goes with it: its avatar and the list of its posts are `404` too.
- Its posts are `404`, and leave every feed on the compactor's next run.
- Its follows, in both directions, its blocks, its mutes, its reports and its roles (admin, server moderator and hashtag moderator) are removed.
- A message it sent stays in the inbox it was sent to, with `from: null`. A [comment](#comments) it wrote stays, with an empty `username`, as a comment does whose author is gone.
- Its username stays taken until the account is gone for good: at once with no posts, otherwise when its last post is removed. Then anyone can register it.

The server always has an admin: the only admin's account can't be deleted (`409`). Make another user an admin first. A [banned](#bans) user can delete their own account too.

The [CLI](CLI.md) does this with `evieverse account delete --yes`, and `evieverse users delete <userId> --yes` for an admin.

### `GET /users/:userId/export`

Authenticated as `userId`. Returns the user's export of their own data: everything the instance holds of them, to keep or to take elsewhere, which is what the GDPR calls access and portability. Only the user reads it, with their own key: anyone else gets `403`, an admin included. A [banned](#bans) user can read theirs too.

An account can hold any amount, so the export is never made whole. It's read a page at a time, and nothing is kept between two pages:

```bash
curl "localhost:3000/users/$USER_ID/export" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

```json
{ "userId": "...", "nextCursor": "WyJwb3N0cyIsMTc5…", "records": [
  { "type": "account", "userId": "...", "username": "alice", "createdAt": "2026-10-02T09:15:00.000Z", "…": "…" },
  { "type": "apiKey", "keyId": "...", "createdAt": "2026-10-02T09:15:00.000Z", "revokedAt": null },
  { "type": "post", "contentId": "...", "preview": { "kind": "text", "text": "Hello" }, "…": "…" }
] }
```

It takes:
- `limit`: the most records in the page, 500 by default, from 1 to 1,000.
- `cursor`: the previous page's `nextCursor`. Ask for pages until `nextCursor` is `null`, and the records of all of them are the export.

A page ends at `limit` records, or sooner, once its records come to about 1 MB of JSON: it always has at least one record, until the last page, which can be empty. A cursor doesn't expire, so an export that stopped is taken up again from its last cursor.

Every record says what it is in `type`. They come in this order, each kind in an order of its own that never changes:

| `type` | What it is | It has |
| --- | --- | --- |
| `account` | The account, once. | `userId`, `username`, `createdAt`, `usernameSetAt` (when the user registered, or last changed their name), their [profile](#a-users-profile) (`bio`, `links`, `avatarUrl`, and `pinnedContentIds`: every post they pinned, the one pinned last first, whether or not anyone else can read it now), `language` (`null` for the instance's default), `admin`, `moderator`, `messages`, `showFollowing`, `showFollowers`, and `bannedAt` (`null` unless they're banned). Not why they were banned, nor by whom. |
| `apiKey` | Each API key the account has had. Never the key. | `keyId`, `createdAt`, `revokedAt` |
| `post` | Each of the user's posts, oldest first, as [`GET /content/:contentId`](#get-contentcontentid) gives it to its publisher. Posts that wait in the moderation queue are there, with their `status`; posts set for deletion aren't. | `contentId`, `preview`, `text`, `mentions`, `tags`, `mimeType`, `comments`, `size`, `images`, `likes`, `aiGenerated`, `contentUrl`, `createdAt`, `updatedAt`, and `origin` on a repost of a post on another server |
| `comment` | Each [comment](#comments) the user wrote, oldest first, with the ones that wait in the moderation queue (`status: "pending_review"`). | `commentId`, `contentId`, `parentId`, `text`, `mentions`, `aiGenerated`, `media`, `createdAt`, `editedAt`. Not its likes or its replies, which are what others did. |
| `like` | Each post the user liked. | `contentId`, `likedAt` |
| `commentLike` | Each comment the user liked. When isn't kept. | `contentId`, `commentId` |
| `repost` | Each post the user [reposted](#post-repost), with the hashtags the repost gave it. | `contentId`, `tags`, `repostedAt` |
| `following` | Each user they [follow](#following). | `userId`, `username`, `followedAt` |
| `follower` | Each user who follows them. | `userId`, `username`, `followedAt` |
| `block` | Each user they [block](#blocks). | `userId`, `username`, `blockedAt` |
| `mute` | Each hashtag a moderator muted them on. | `tag`, `mutedAt` |
| `moderatedTag` | Each hashtag they moderate. | `tag`, `since` |
| `report` | Each post and each comment they [reported](#post-report), with what they said. Not what the moderators decided. | `contentId`, `commentId` for a comment, `reason`, `reportedAt` |
| `inbox` | Everything in their [inbox](#inbox), oldest first: each item as the inbox's own list gives it, with its `text` in the user's language. | `messageId`, `kind`, and the rest of the item |
| `sentMessage` | Each [message](#post-messages) they sent, as far as its recipient still has it: one the recipient deleted, or that is older than an inbox keeps messages, is gone. | `messageId`, `to` (`{ userId, username }`, or `null` once the recipient's account is gone), `text`, `sentAt` |

What to know about it:

- **Files aren't in the export.** A post's record has its `contentUrl`, an image post's has each of its `images` with its own `url`, and a comment's `media` has its `url`: whoever keeps the export fetches the bytes from there, as any reader does. The account's record has its `avatarUrl`, which answers `404` while the user is banned.
- **It isn't a snapshot.** Each page reads what is there when it's asked for, while the account is in use. What is there throughout is in the export exactly once. What is written or deleted meanwhile is in it or not, by where the export had got to.
- **A new post or an edit is in it at once.** A comment the user just sent, and a like of a comment, are in it after the [compactor](APP.md#8-the-compactor)'s next run, which is seconds. A like that was [taken back](#delete-like) isn't in it: a post's at once, and a comment's after that run.
- **What it leaves out:** what moderators hold about the user and don't tell them (why they were banned, what was decided about their reports), what the user did as a moderator or an admin (decisions, blocked words, rules, ads), the operator's logs, counts that are kept for minutes (limits), and a file that was uploaded and never posted.
- **Reading it changes nothing,** so it leaves no record in the [audit log](DEPLOY.md#audit-log). The server's own log has a line when an export is started.

| Status | What happened |
| --- | --- |
| `200` | A page of the export. |
| `400` | The `cursor` isn't one of an export's, or `limit` isn't from 1 to 1,000. |
| `403` | The path names another user. |
| `429` | The user read 120 pages in the last minute (`EXPORT_PAGES_PER_MINUTE`). The response says when to try again, in a `Retry-After` header and as `retryAfterSeconds`. At that pace a large account is still exported in minutes. |
| `503` | The export isn't ready: the server is still indexing the comments it had before it kept an index of each user's, which it does once, after an upgrade. Every page of every export gets this until it's done, with `Retry-After: 60`, so that no client takes an export without its old comments for a whole one. |

### `GET /whoami`

Authenticated. Returns the account the key belongs to, its language, its roles and its settings: `{ userId, username, language, admin, moderator, moderates, banned, messages, showFollowing, showFollowers }`, with `admin`, `moderator` and `moderates` as in the profile. `banned` is whether a moderator [banned](#bans) the account, which can't then post, comment, like or send messages. `language` is the code of the language the instance answers the user in, `messages` is whether the user takes part in [messages between users](#post-messages), and `showFollowing` and `showFollowers` are whether they show whom they [follow](#following) and who follows them. The [CLI](CLI.md) checks a key with it when you sign in.

### `GET /languages`

Lists the languages the instance answers in, in the order of their codes, and which of them is its default. It needs no key.

```bash
curl localhost:3000/languages
```

```json
{ "default": "en",
  "languages": [{ "code": "en", "name": "English" }, { "code": "es", "name": "Español" }] }
```

| field | notes |
| --- | --- |
| `default` | The code of the instance's default language (`DEFAULT_LANGUAGE`, `en`). |
| `languages` | Every language the instance has, each `{ code, name }`. `code` is what [`POST /register`](#post-register) and [`PATCH /users/:userId`](#get-usersuserid-and-patch-usersuserid) take as `language`, in any case. `name` is the language's name in the language itself, for a client to show in a list. |

An instance has one language per file of its `languages` folder, so adding a file adds a language ([LANGUAGES.md](LANGUAGES.md)).

What the instance says is in one of these languages: the `error` of an error response, the `note` that comes with a new key, the `text` of a [notice](#notices). Posts and comments aren't: they stay as they were written. Machine-readable values, such as a `status`, are the same in every language, so a client should go by the status code and those, never by the wording of an `error`.

The language of a response is:
1. **The user's**, on a request that is [authenticated](#authentication): the one they [registered in](#post-register), or [changed to](#get-usersuserid-and-patch-usersuserid) since, whatever the request's headers say.
2. Otherwise **the one the `Accept-Language` header asks for**, the most wanted of those the instance has. A regional variant is answered in the closest one there is: `es-MX` in `es`, and `pt` in `pt-BR`.
3. Otherwise **the instance's default**.

A language that lacks a message says it in the default language. Two things are in English whatever the language: most of what `details` says about the fields of a request that doesn't validate, and the errors of requests that never reach an endpoint (a body that isn't JSON, a path that isn't there).

## Posts

### `POST /store`

Creates or updates a post. Send it as JSON, or as `multipart/form-data` with the file in a part named `content`. A file can also go straight to the content store first, and be posted by its `uploadId` ([`POST /uploads`](#post-uploads)). An image post can have several images, up to 10: an [album](#albums). A [banned](#bans) user is refused (`403`), for an update of their own post as for a new one.

Every post has a `type`:

| `type` | The post |
| --- | --- |
| `image`, `video`, `audio` | A file of that type (`image/*`, `video/*` or `audio/*`) in `content` or sent before as `uploadId`, with an optional caption in `text`. An image is a JPEG, PNG, GIF or WebP, is stored [without its metadata](#images), and can have an [alt text](#alt-text). An `image` post takes up to 10 images ([below](#albums)); a `video` or `audio` post takes one file. A video is [processed](#videos) before the post is published: made an MP4 that plays anywhere, without its metadata, with a poster and an adaptive stream. |
| `text` | Its `text`. |
| `link` | Its `url` alone. Any other file, such as a PDF or a web page, is posted as a link to it. |

A server takes all five types unless its operator turned some off (`POST_TYPE_TEXT`, `POST_TYPE_IMAGE`, `POST_TYPE_VIDEO`, `POST_TYPE_AUDIO`, `POST_TYPE_LINK`). A post of a type that's off is refused with `400`, as a new post and as an update, and the error names the types the server takes. The posts of that type the server already holds can still be read, liked and deleted. No endpoint lists the types: a server says which it takes in its [rules](#get-rules).

| field | notes |
| --- | --- |
| `type` | Required: `image`, `video`, `audio`, `text` or `link`. One the server has turned off gets `400`. |
| `text` | A text post's text (required), or an image's, video's or audio's caption (optional). At most 40,000 characters, trimmed of leading and trailing whitespace. It can be formatted (bold, italic, links, lists and so on) as [TEXT_EDITORS.md](TEXT_EDITORS.md) describes: the formatting is part of the text, and is stored and returned as written. A link post has none (`400`). An update sends the whole post again, so one without `text` drops the caption. |
| `url` | A link post's URL (required): `http` or `https`, at most 2,048 characters. Other types have none (`400`). |
| `content` | An image's, video's or audio's file: a file part (multipart), or a string in JSON with `contentEncoding: "base64"` (a JSON request can be at most 32 MB). Required for those types unless `uploadId` or `images` is given; a text or link post has none (`400`). A file larger than `MAX_UPLOAD_BYTES` (5 GiB) gets `413`. An [album](#albums) sent as multipart has one file part named `content` for each image, in order. |
| `uploadId` | In place of `content`: a file already sent with an upload link from [`POST /uploads`](#post-uploads). Not together with `content` (`400`). |
| `images` | JSON only, and only for an `image` post (`400` otherwise): the images of an [album](#albums), in the order they're shown, as a list of `{ content }` or `{ uploadId }`, at most 10, each with its own `alt` if it has one. In place of `content` and `uploadId`, not with either (`400`). |
| `alt` | Optional, and only for an `image` post (`400` otherwise): the image's [alt text](#alt-text), which describes it to people who can't see it. At most 1,500 characters. An album gives one for each image. |
| `contentType`, `filename` | Optional hints for the file. Otherwise its content type comes from the upload or the file extension, and it must match the post's `type`: an `image` post of a PDF gets `400`. An image's content type is then read from the file itself. An image in `images` says its own. |
| `contentId` | Optional. If set, updates content you own (otherwise 403). Content has one version: the update writes over it, and what it was before isn't kept. Read by its id it's as it now is straight away, and feeds that already list it show it as it now is after the compactor's next run. The update must have the same type and content type as the original (a PNG image stays a PNG; for an album, that's its first image), otherwise `400`. Where the server [processes videos](#videos), a video post is updated with a video of any type, since each is made the same MP4. Content set for deletion can't be updated (`409`). Of two updates of the same content sent at once, the last to commit wins, whole: the content is never parts of both. |
| `tags` | Your hashtags. Required. A list (`["news", "mumbai"]`), or one string separated by commas or spaces (`"news, #Mumbai"`, as in a form field). Each is normalised (`#Central-Mumbai` becomes `centralmumbai`); one with nothing usable left, or more than 10, gets `400`. In `server` [tagging mode](#hashtags), so does one that isn't among the server's ([`GET /tagging`](#get-tagging) lists them). On an update, hashtags that aren't the content's change it, even when nothing else did. |
| `aiGenerated` | Optional. The publisher's declaration that the content was created with AI: `true` or `false` (a JSON boolean, or the string in a form field). Defaults to `false` for new content. An update that leaves it out keeps the content's value, and changing only this is an update too. Feeds return it on every record and can filter on it. |
| `comments` | Optional. Whether the post takes [comments](#comments): `true` or `false` (a JSON boolean, or the string in a form field). Defaults to `false` for new content. An update that leaves it out keeps the content's value, and changing only this is an update too. Turning it off closes and hides the post's comments without deleting them: they're back when it's turned on again. |

The request is synchronous:
1. **The post is [moderated](#moderation).** It gets a trust score, which says where it goes. With the default thresholds, a post containing a word or phrase the server blocks is refused with `422`, and so is one that none of its hashtags is allowed on: nothing is stored. Otherwise it keeps the hashtags that are allowed, and is either published or, if its score is between the thresholds, held in the [moderation queue](#the-moderation-queue).
2. **If you already posted 3 times in the last minute** (`POST_RATE_LIMIT_PER_MINUTE`), the request is refused with `429` and when to try again ([above](#limits-on-posts-and-comments)), and nothing else is done. New content and updates are posts; storing the same content again unchanged isn't. A post that fails doesn't count either. Posts claim their place atomically, in Redis, so of several sent at once, no more get through than the limit allows.
3. An image's, video's or audio's file is written to the content store, under a name of the request's own (`staged/<writeId>`), where it waits. Each image of an album is written under a name of its own. The request writes nothing else of the post there, nor to the summary store or Redis.
4. The post is committed to the database: its row, and the post as this request makes it (its description, with a text post's text or a link's URL), for the compactor to write out. If this fails, the request fails, the file of step 3 is removed (every image of an album), and nothing is added to any feed. An update that fails changed nothing: the content is as it was.
5. The same commit queues the post for the feed index: one row for each of its hashtags, and one for its publisher's own index. The request is then done, and the post can be read at `GET /content/:contentId`, and its bytes at `/raw` (an album's images at `/raw` and `/raw/<n>`).
6. The [compactor](APP.md#8-the-compactor) writes the post out on its next run: its bytes to `content/<id>` (an album's images after the first beside them, at `content/<id>.<n>`), its summary, with the [preview](#previews), to the summary store and Redis, and then its meta file, over what was there for an update. The same run puts the post in its hashtags' feeds, and its publisher's followers'. That's `COMPACT_INTERVAL_SECONDS` later at most (5 by default), plus the time the run takes. Until then no feed has it, so a client that wants to show a new post at once shows it from the response.

A video post has one more step between 5 and 6: its video is [processed](#videos), and the compactor writes the post out only once that's done. Until then the post says `processing: true`.

An update is in feeds the same way, after the compactor's next run. Until then feeds show the content as it was:
- Where a feed already lists the content, it then shows as it now is, in its original place.
- A hashtag the update dropped then stops returning the content.
- A hashtag the update added then returns it.

The response is `201` for new content and `200` for an update, with `{ contentId, tags, preview, aiGenerated, comments }`, plus `removedTags` when moderation dropped some of the post's hashtags, `mentions` when its text or caption [mentions](#mentions) users, and `processing: true` when its video is yet to be [processed](#videos). An update that changes nothing (the same AI flag, comments flag and hashtags as the content has, and the same text or URL, or the same caption and file) stores nothing, and returns `{ contentId, unchanged: true }`, with `status: "pending_review"` for content that waits in the moderation queue. A file is the content's if its bytes as stored are the same, which the server tells by their SHA-256: for an image, that's the image without its metadata, so the same picture sent with other metadata is the same file. An album is unchanged when it has the same images in the same order: the same ones in another order, or with one more or one fewer, is an update. So is an image whose [alt text](#alt-text) is another, or gone. A video is the content's if it's the file the post was last sent, as it was sent. A video or audio file sent with an upload link (`uploadId`) isn't compared, and is stored again whenever it's sent; a video that turns out to be the one the post has isn't processed again.

A post held in the [moderation queue](#the-moderation-queue) is answered `202` instead, with `status: "pending_review"` beside the same fields. It's stored (steps 3 and 4), but nothing is queued for the feed index, so it's in no feed until a server moderator or an admin accepts it. A held update of published content is `404` by its id at once, to everyone but those who can read it in the queue. Feeds stop returning it after the compactor's next run, which erases the content's summary, which they render from.

```bash
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F type=video -F text="Sunrise over the harbour" -F tags=video,travel -F aiGenerated=true -F content=@clip.mp4
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d '{ "type": "link", "url": "https://example.com/report.pdf", "tags": ["news"] }'
```

#### Images

An image post is a JPEG, PNG, GIF or WebP. The server tells which by the file's first bytes, not by `contentType` or `filename`, and that's the post's `mimeType`: a PNG sent as `image/jpeg` is stored as `image/png`. Any other file gets `400`, including SVG, HEIC, AVIF, TIFF and BMP, and so does an image that's cut short or isn't laid out as its format says.

The image is stored without its metadata: EXIF (with the GPS position a phone records), XMP, IPTC, comments, embedded thumbnails, and anything appended after the image, such as the video of a motion photo. The pixels aren't touched: nothing is re-encoded, and colour profiles, transparency, animation and the image's orientation are kept. So the file `GET /content/:contentId/raw` returns isn't byte for byte the one you sent, and `size` is that of the file as stored.

Audio files are stored as they're sent, metadata included, under the content type they're sent with. Videos aren't: see [below](#videos).

#### Alt text

An image can have an alt text: a description of what it shows, for people who can't see it. A screen reader reads it out in the image's place, so a client should put it in the image's `alt` attribute, or whatever its platform has for that.

- **It's optional, and at most 1,500 characters,** trimmed of leading and trailing whitespace. A longer one gets `400`. An empty one is none.
- **Only an image has one.** `alt` on a `text`, `video`, `audio` or `link` post gets `400`.
- **It's plain text,** not a [formatted text](TEXT_EDITORS.md): it's read out as written.
- **How to send it:**
  - For a post of one image, in the `alt` field, as JSON or as a form field.
  - For an [album](#albums) sent as JSON, in each item of `images`: `{ content, alt }` or `{ uploadId, alt }`. The post's own `alt` beside `images` gets `400`.
  - For an album sent as multipart, in one `alt` field for each file part, in the order of the parts. Send an empty `alt` for an image that has none, so the ones after it stay with their images. Fewer `alt` fields than files describe the first images; more get `400`.
- **Where it's returned:**
  - In the post's [preview](#previews), as `alt`: a list with one string for each image, in the images' order, `""` for an image that has none. A post none of whose images has one has no `alt`.
  - In `images` of [`GET /content/:contentId`](#get-contentcontentid), as each image's own `alt`. An image without one has none.
- **An update sends it again,** as it sends the whole post: an update without `alt` drops it. Changing only the alt text is an update too.
- **It's [moderated](#moderation) as the caption is.** A word the server blocks is blocked there too.

```bash
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F type=image -F tags=travel -F alt="A tram climbing a steep cobbled street" -F content=@tram.jpg
```

#### Videos

A server processes the videos it's sent, unless its operator turned that off (`VIDEO_PROCESSING=false`). A video isn't published as it was sent:

- **It's made an MP4 that plays anywhere:** H.264 video and AAC sound, upright, at most 720 pixels on its shorter side. That's the post's bytes, at `/raw`, and the post's `mimeType` is `video/mp4` whatever was sent.
- **Its metadata is removed,** as an [image's](#images) is: where and when it was filmed, the device, its title and comments, chapters, subtitles and data tracks. Nothing of the file as it was sent is kept.
- **It gets an adaptive stream** (HLS), in several sizes: 1080, 720, 480 and 240 pixels on the shorter side by default (`VIDEO_HEIGHTS`), leaving out the ones larger than the video. A player picks the size its connection carries, and changes as that changes.
- **It gets a poster:** a JPEG of a frame near its start, to show before it plays.

The server reads MP4, MOV, 3GP, WebM, Matroska, AVI, MPEG-TS, MPEG-PS, WMV, FLV and Ogg files. A picture larger than 8,192 pixels a side is refused.

Processing takes a while, from seconds to minutes by the video's length, so it's done after the request:

1. `POST /store` answers as soon as the file is stored, with `processing: true` beside the usual fields. Its `preview` has no `video` yet.
2. While it's processed, [`GET /content/:contentId`](#get-contentcontentid) returns the post as written, with `processing: true`. No feed has it, and `/raw` answers `404`: there's nothing to play yet.
3. Once it's done, the post is published as any post is, in feeds after the compactor's next run. `processing` is gone, and `preview.video` is there. A client that shows the post while it waits asks `GET /content/:contentId` again every few seconds until then.

A processed video's preview:

```json
{ "kind": "video", "url": "/content/0b7c0f5e-…/raw", "text": "Sunrise over the harbour",
  "video": { "id": "6a1d…", "width": 1280, "height": 720, "duration": 42.5,
             "poster": "/content/0b7c0f5e-…/video/6a1d…/poster.jpg",
             "hls": "/content/0b7c0f5e-…/video/6a1d…/master.m3u8" } }
```

| field | notes |
| --- | --- |
| `url` | The MP4. Every browser and phone plays it. |
| `video.width`, `video.height` | The size of the video's largest rendition, in pixels, upright. Use them to lay the player out before anything loads. |
| `video.duration` | Its length in seconds. |
| `video.poster` | The poster, a JPEG. |
| `video.hls` | The stream's master playlist. Safari and iOS play it as a video's source; other browsers need a player script such as hls.js. A client that has neither plays `url`. |
| `video.id` | The id of this version of the video. An update with another video has another, so the addresses under it never change what they return. |

A video the server didn't process (one stored before processing was on, or on a server that has it off) has no `video` in its preview: `url` is the file as it was sent.

`GET /content/:contentId/video/:videoId/:file` returns one file of the video: `poster.jpg`, `master.m3u8`, a rendition's playlist (`720p.m3u8`) or one of its segments (`720p_00000.ts`). A client needs only the two addresses in the preview: a player finds the rest from the playlists. Whoever can read the post can read them. Playlists are always sent by the server; the poster and the segments are a redirect to the content store where it signs links, as `/raw` is. `404` for a file the video doesn't have, and for a `videoId` the post no longer has.

An update of a video post:

- **With another video,** the post says `processing: true` until the new one is processed. Read by its id, it's the update as written: the new caption and hashtags, and a `preview` with no `video`. `/raw` returns the old video until the new one is ready, the old video's poster and stream stay where they were, and feeds show the post as it was. Once the new one is ready, the old one's files are deleted, and their addresses answer `404`.
- **With the same file,** the answer says `processing: true` too, but nothing is made again: the post keeps the video it has, and is ready as soon as the server has seen that the file is the same.

A video that can't be processed (a file that isn't a video, one that's broken, or one that takes longer than `VIDEO_TIMEOUT_SECONDS`) is reported to its publisher with a [notice](#notices):

- **A new post is deleted.** It was never published.
- **An update keeps the video the post had.** The rest of the update is made.

While a post is processing it can be liked, reposted and commented on, as any post that's read by its id can.

#### Albums

An image post can have several images, at most 10: an album, or carousel. They're shown in the order they're sent. A post of one image is as it always was, and is sent as it always was.

How to send them:

- **As multipart:** one file part for each image, each named `content`, in the order they're shown. A file part with another name gets `400`.
- **As JSON:** in `images`, a list with one item for each image:

  | field | notes |
  | --- | --- |
  | `content` | The image inline, as a string, encoded as the request's `contentEncoding` says (`"base64"` for an image). The whole request can be at most 32 MB, all its images together. |
  | `uploadId` | In place of `content`: an image already sent with an upload link from [`POST /uploads`](#post-uploads). Each image has a link and an `uploadId` of its own. |
  | `contentType`, `filename` | Optional hints for this image, as the post's own are for a post of one file. An inline image that gives neither is taken for an image, and its bytes say which. |

  | `alt` | Optional: this image's [alt text](#alt-text). |

  An item has `content` or `uploadId`, one of them (`400` otherwise). A list can mix the two. `images` comes in place of the post's own `content` and `uploadId`, and not with either, or with file parts (`400`).

What holds for each image, and for all of them:

- **Each image is held to what the one image of a post is.** It's a JPEG, PNG, GIF or WebP by its bytes, and is stored [without its metadata](#images). An album can mix the formats.
- **The size limit is on each image,** not on the album: one larger than `MAX_UPLOAD_BYTES` gets `413`.
- **If one image is refused, the post is,** and nothing of it is stored.
- **More than 10 images get `400`.** So do several files on a `video` or `audio` post, and `images` on a post that isn't an `image` post.
- **The post's `mimeType` and `size` are its first image's.** [`GET /content/:contentId`](#get-contentcontentid) lists every image with its own, in `images`.
- **The [preview](#previews) says how many images there are,** in `imageCount`, and where the first is. The others are at the same address with their number after it.
- **Each image can have its own [alt text](#alt-text).** The preview's `alt` lists them in the images' order.
- **An update sends every image again,** as it sends the whole post: the images it leaves out are deleted. That's how images are added, removed and put in another order. Its first image must be of the content type the post has (an album that starts with a PNG is updated with one that starts with a PNG); the others can be of any of the four. A post of one image can become an album, and an album a post of one image.

```bash
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F type=image -F text="Three days in Lisbon" -F tags=travel,lisbon \
  -F content=@day1.jpg -F content=@day2.jpg -F content=@day3.png \
  -F alt="A tram on a steep street" -F alt="" -F alt="The river at dusk, from a rooftop"
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d "{ \"type\": \"image\", \"tags\": [\"travel\"], \"contentEncoding\": \"base64\",
        \"images\": [ { \"content\": \"$(base64 < day1.jpg | tr -d '\n')\", \"filename\": \"day1.jpg\" },
                      { \"uploadId\": \"$UPLOAD_ID\", \"filename\": \"day2.jpg\" } ] }"
```

### `POST /uploads`

Gives a link to send an image, video or audio file straight to the content store, for files too large for a request to the server to carry. When the server runs as functions, that's anything over a few megabytes ([DEPLOY.md](DEPLOY.md#uploads)). A [banned](#bans) user is refused a link (`403`), as a link is for posting the file.

| field | notes |
| --- | --- |
| `type` | Required: `image`, `video` or `audio`, as the file will be posted. One the server has [turned off](#post-store) gets `400`. |
| `size` | Required: the file's size in bytes. More than `MAX_UPLOAD_BYTES` gets `413`. |
| `contentType`, `filename` | The file's content type, or a filename to tell it from. It must match `type`, otherwise `400`. |

The response is `201` with `{ uploadId, upload: { method, url, headers }, expiresAt, maxBytes }`. Then:
1. Send the file's bytes as the body of one request to `upload.url`, with the method and every header in `upload`, before `expiresAt` (15 minutes, `CONTENT_SIGNED_URL_SECONDS`). The link needs no other credentials, so a browser can send the file itself.
2. Post it: `POST /store` with `uploadId` in place of `content`, and the same `type`. The server checks the file as it would one sent in the request: its size (`413`), and that it's there and not empty (`400`). A post that's refused for being past the [limit on posts a minute](#limits-on-posts-and-comments) (`429`) is sent again with the same `uploadId`: the file isn't uploaded again.

The images of an [album](#albums) are sent the same way, one link for each: ask for a link per image, send each image to its own, and post them with their `uploadId`s in `images`.

The image or video of a [comment](#post-contentcontentidcomments) is sent the same way: ask for the link with `type` `image` or `video`, and send the comment with the `uploadId`.

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

Either way, a post without `tags` gets `400`. These checks come before the [limit on posts a minute](#limits-on-posts-and-comments), so a post that can't go through doesn't count towards it. [Moderation](#moderation) can then drop some of a post's hashtags, and refuses a post left with none.

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
| `image`, `video`, `audio` | `{ kind, url, text }`: a link to the file, and its caption cut the same way. Without a caption, there's no `text`. An [album](#albums)'s also has `imageCount`, how many images it has (2 or more): `url` is the first, and image number `n`, counted from 1, is at `url` with `/n` after it (`<url>/2`, `<url>/3`, …). A post of one image has no `imageCount`. An image post whose images are described has `alt`, their [alt texts](#alt-text): one string for each image, in their order, `""` for an image that has none. A video the server processed has `video`: its size and length, its poster and its adaptive stream ([above](#videos)). |
| `link` | `{ kind: "link", url }` |

A preview's `text` is a [formatted text](TEXT_EDITORS.md#the-format), as the text or caption it's cut from is, and read by the same rules. It's one paragraph, and its formatting is whole: what was bold or a link where the text was cut is closed there, and a ` …` follows (`**one two** …`).

The whole text is in [`GET /content/:contentId`](#get-contentcontentid).

### Mentions

A text post's text, a caption and a comment's text mention a user with `@` and their username: `Thanks @alice`. A mention does two things: the user gets a [notice](#notices) in their inbox once the text is published, and a client shows the mention as a link to the user's profile ([`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid)).

A username can hold any characters, spaces among them, and its user can change it, so a text alone doesn't say where a name ends or whose it is. The server settles that when the text is written, and returns the answer with the text:

```json
{ "text": "Thanks @alice and @Ann Lee!",
  "mentions": [{ "userId": "...", "username": "alice" }, { "userId": "...", "username": "Ann Lee" }] }
```

- **`mentions`** lists the users the text mentions, in the order it first names them: each with the `username` the text has them by, and the `userId` to link to. A text that mentions nobody has no `mentions`. The text itself is stored and returned as it was sent.
- **It comes with every text:** in the response of [`POST /store`](#post-store), in [`GET /content/:contentId`](#get-contentcontentid), in a [comment](#comments) wherever one is returned, on a post or a comment in [the moderation queue](#the-moderation-queue), and in the user's [export](#get-usersuseridexport). A [feed](#get-feed) record has the ones its `preview.text` mentions.
- **A client reads the text with its `mentions`:** an `@` followed by one of those names is a mention, and any other `@` is the character. [TEXT_EDITORS.md](TEXT_EDITORS.md#mentions) has the rules, which the server's parser follows.
- **A mention is of a user by the name they have,** to the letter, capitals included. Of several names that fit, the longest is the one: `@Ann Lee` is Ann Lee where there's an Ann too. A name that is no user's is text.
- **It's not a mention** after a letter or a digit (`mail@alice.example`), in code, in the label of a link, or written `\@`.
- **A text mentions 10 users at most.** What it names after the tenth is text. Only the first 50 `@` of a text are looked at.
- **An update or an edit goes on mentioning whom the text mentioned.** A name that was a mention in the text being replaced is the same user's in the new one, even if they have changed their name since and someone else has taken it. Any other name is looked up as it is then.

The notice is `post_mention` or `comment_mention`, with who wrote the text as its `from`:

- **It's sent when the text is published:** at once for a post or comment that's published, and when it's accepted for one that waits in the moderation queue. One that's rejected tells nobody.
- **Each user is told once** of a text that mentions them, however often it names them, and nobody is told of what they wrote themselves.
- **An update or an edit tells only whom it newly mentions:** not those the text mentioned before, nor a user who still has the notice of an earlier mention in the same post or comment in their inbox.
- **A [block](#blocks) stops it,** in either direction. The mention is still in the text, and still a link.
- **It isn't a message.** Turning messages off (`messages: false`) doesn't turn it off, and it counts towards no limit on messages. What bounds it is the [limits on posts and comments](#limits-on-posts-and-comments), and the 10 mentions a text.

### `GET /content/:contentId`

Returns the publisher credit first: `publisher: { userId, username, avatarUrl }`, with `avatarUrl` where the publisher has an [avatar](#the-avatar), and without it where they have none, or are [banned](#bans). Then come `contentId`, `preview`, `text` (a text post's whole text, or a caption), `mentions` (the users that text [mentions](#mentions), where it mentions any), `tags`, `likes`, `mimeType`, `aiGenerated`, `comments` (whether the post takes [comments](#comments)), `size`, `contentUrl`, `images` (on an image post), `createdAt` and `updatedAt`. A post whose video is still being [processed](#videos) has `processing: true`. Where the instance shows [ads](#ads) on posts, `ad` comes last: one ad to show at the post's end, `{ adId, label, kind, imageUrl?, imageAlt?, text?, url? }`, as in [`GET /feed`](#get-feed). A post with no ad to show has none.

An image post has `images`, its images in the order they're shown: `[{ url, mimeType, size, alt? }]`, each with where its bytes are read, its content type, its size in bytes as stored, and its [alt text](#alt-text) if it has one. A post of one image has one item, whose `url` is `contentUrl`. An [album](#albums) has one for each image: the first at `contentUrl`, and the others at `contentUrl` with their number after it (`/content/<contentId>/raw/2`, and so on). The post's own `mimeType` and `size` are the first image's. No other post has `images`.

A post that was [reposted](#post-repost) also has `reposts`, the reposts made of it, and a repost of a [post on another server](#a-post-on-another-server) has `origin`, and neither `size` nor `text`, nor `images`. Its `origin` has `attestedAt` here: when the original's server signed what the instance shows of it.

A post that a hashtag's moderator decided about has `moderation`: what moderators did to it under its hashtags, oldest first, for a client to show beside the post.

```json
"moderation": [
  { "action": "tag_removed", "tag": "cars", "by": "tag_moderator", "reason": "it has no cars in it",
    "at": "2026-11-18T09:30:00.000Z",
    "text": "#cars was removed from this post by a moderator of the hashtag: it has no cars in it" }
]
```

| field | notes |
| --- | --- |
| `action` | `tag_removed`: a moderator [removed the hashtag from the post](#a-hashtags-queue). `tag_approved`: one approved the post under it. |
| `tag` | The hashtag. |
| `by` | As what the moderator did it: `tag_moderator` (one of the hashtag's own), `server_moderator` or `admin`. Never who: the post doesn't name the moderator, to its publisher or to anyone else. |
| `reason` | Why the hashtag was removed, where the moderator said: at most 500 characters. Whoever can read the post can read it. |
| `at` | When. |
| `text` | All of it in words, in the reader's [language](#get-languages): "#cars was removed from this post by a moderator of the hashtag", with the reason after it where there is one, or "This post was approved under #news by an admin." |

- It's there as soon as the moderator decided, before the compactor has applied the decision to the feeds.
- It stays as it is for as long as the post does: an approval that an update of the post ended is still listed, since it happened.
- It lists the 100 most recent, which is all of them for all but a post approved again after update upon update.
- Only what a moderator decided about this post is in it. A hashtag the post didn't get when it was written, for the hashtag's [blocked words](#blocked-words) or a mute of its publisher, isn't: the response to `POST /store` says that, in `removedTags`.
- A post no moderator decided about has no `moderation`, and feed records never have it.

`GET /content/:contentId/raw` streams the content's bytes as they are now, with their content type. The link stays the same across updates, so a cache or CDN in front decides how long a copy is good for. On stores that support presigned URLs (S3, GCS, ...), it redirects to one instead, valid for `CONTENT_SIGNED_URL_SECONDS` (900). Azure Blob Storage isn't one of them: the server signs links to upload with there, but streams the bytes to read. Bytes the server streams itself come with `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` that sandboxes them: a browser shows or plays the file, and a page opened on it runs no script.

A video post's bytes are the MP4 the server [made of the video](#videos). While a new post's video is processed, `/raw` answers `404`; while an update's is, it returns the video the post had.

`GET /content/:contentId/raw/:n` returns image number `n` of an [album](#albums), counted from 1, the same way: streamed with the image's own content type, or a redirect. `/raw/1` is `/raw`, so `/raw` is an album's first image. A number past the post's last image gets `404`, which on a post that isn't an album is any number after 1. Whoever can read the post can read each of its images. An update takes effect here at once: an image it left out is `404` from then on, and the numbers are those of the images as they now are.

Both return `404` for content set for deletion.

Content waiting in the [moderation queue](#the-moderation-queue) isn't published, so both return `404` for it too, except to its publisher, to server moderators and to admins, who send their credentials in the headers (`Authorization: Bearer <apiKey>` and `X-User-Id`). They get it with `status: "pending_review"`.

A repost of a post on another server is hidden the same way while that server says the post is gone ([below](#refreshing-a-repost)): `404` from both, except to the same three, who get it with `status: "origin_gone"`, and in `origin`, `goneAt` (since when) and `deleteAfter` (when the instance deletes the entry, unless the post is attested again before).

One address can ask for 300 posts a minute (`CONTENT_RATE_LIMIT_PER_MINUTE`), then gets `429` ([below](#limits-on-reads-that-need-no-key)). `/raw` isn't limited.

### `DELETE /content/:contentId`

Authenticated. Only the original publisher or an [admin](#moderation) can delete content, otherwise `403`. Returns `202` with `{ contentId, status: "pending_deletion", requestedAt }`, and repeating the request returns the same response. When an admin deletes someone else's post, its publisher gets a [notice](#notices) in their inbox.

The content can't be read from then on: `GET /content` and `/raw` return `404`, likes return `404`, and updates (`POST /store` with its `contentId`) return `409`. Its [comments](#comments) go with it: they can't be read, added to, edited, liked or reported from then on.

Nothing is removed at the request. The content is set for deletion, and the compactor's next run (every `COMPACT_INTERVAL_SECONDS`, 5 by default) removes it from every hashtag's index and its publisher's, then deletes its comments, its database row (with its likes), its bytes, its meta file and its summary. Feeds return it until that run, and not after it, including on later pages of a feed session that already started.

### `POST /repost`

Reposts someone else's post: gives it hashtags it doesn't have. The post then shows under each of those hashtags, and in the [following feeds](#get-feedfollowing) of the reposter's followers, as a new post there: placed at the time of the repost, with the likes it got since.

Nothing is copied. The post stays one post, with one like count, credited to its publisher, and under the hashtags it already had it stays where it was. So a repost never moves a post: it adds places to find it in.

```json
{ "userId": "...", "apiKey": "...", "contentId": "...", "tags": ["mumbai", "travel"] }
```

| field | notes |
| --- | --- |
| `contentId` | The post to repost, on this instance. A request names one post: `contentId` or `origin`, and not both (`400`). |
| `origin` | In place of `contentId`: a post on another server, as that server signed it: `{ attestation }` ([below](#a-post-on-another-server)). |
| `tags` | Required: the hashtags the repost gives the post, at least one and at most 10, written as a post's are: a list, or one string separated by commas or spaces. In `server` [tagging mode](#hashtags) they must be among the server's. Otherwise `400`. |

Authenticated. A [banned](#bans) user is refused (`403`). An instance can turn reposts off (`REPOSTS=false`), and the request then gets `400`.

What can be reposted:
- **Any published post but your own.** Your own post gets other hashtags by an update ([`POST /store`](#post-store)), so a repost of it gets `400`. A post that waits in the [moderation queue](#the-moderation-queue), is set for deletion or isn't there gets `404`.
- **Once.** A post you already reposted gets `409`.
- **With a hashtag it doesn't have.** That keeps a repost from being a way to bring a post back to the top of the feeds it's already in.

Each hashtag is then held to its own [moderation](#moderation), as a post's hashtags are, and the post gets the ones that pass. Those it doesn't get are listed in `removedTags`, each with a `reason`:

| `reason` | Why the post didn't get the hashtag |
| --- | --- |
| `already_tagged` | The post has it already, from its publisher or from another repost. |
| `muted` | You are muted on the hashtag, or the post's publisher is. |
| `removed` | A moderator of the hashtag removed it from this post. |
| `blocked_word` | The post has one of the hashtag's [blocked words](#blocked-words). |

- A repost left with no hashtag is refused with `422`, and `removedTags` says why: nothing is reposted.
- Reposts can give one post at most 10 hashtags between them, beside the 10 its publisher can give it. A repost that would go past that is refused with `409`, whole.
- The post isn't given a trust score again: it got one when it was written, and a repost changes nothing of what it says.

**A repost counts as a post** for the [limit on posts a minute](#limits-on-posts-and-comments): nobody posts and reposts more than 3 times in a minute (`429`). That's checked last, so a repost that is refused for another reason doesn't count.

The response is `201` with `{ contentId, tags, repostedAt }`, plus `removedTags` when some hashtags weren't given. `tags` are the hashtags the repost gave the post.

```bash
curl -X POST localhost:3000/repost -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d "{ \"contentId\": \"$CONTENT_ID\", \"tags\": \"mumbai, travel\" }"
```

```json
{ "contentId": "0b7c0f5e-…", "tags": ["mumbai"],
  "removedTags": [{ "tag": "travel", "reason": "already_tagged" }],
  "repostedAt": "2026-11-10T14:02:00.000Z" }
```

The [CLI](CLI.md) does this with `evieverse repost <contentId> --tags "mumbai, travel"`.

How a repost shows:
- **After the compactor's next run,** as a new post does ([`POST /store`](#post-store)): from then on the post carries the hashtags, [`GET /content/:contentId`](#get-contentcontentid) lists them in `tags`, and the feeds show the post there.
- **In a feed,** a record that is there because of a repost has `repost`: `{ at }`, the time of the repost, which is where the record is placed. In a [following feed](#get-feedfollowing) it also says who reposted: `{ at, by: { userId, username } }`. On such a record `likes` counts the likes since the repost, while `createdAt` and `publisher` are still the post's own.
- **On the post,** `GET /content/:contentId` has `reposts`: one item per repost, oldest first, each `{ by: { userId, username }, tags, at }`. `tags` are the hashtags that repost gave and the post still has, and `by` is left out once the reposter's account is deleted. The post's `likes` is its whole count, wherever the likes were made.
- **A hashtag a repost gave is the post's from then on.** An update's `tags` are the publisher's own, so the publisher keeps the reposted hashtags through updates and can't drop them. It takes a moderator of the hashtag, a server moderator or an admin to [remove](#a-hashtags-queue) one, and it stays when the reposter deletes their account. The hashtag's rules still apply: an update can lose the post a reposted hashtag its publisher is muted on, or whose blocked words the post now has.

#### A post on another server

A post on another server is reposted with its **attestation**: what that server says the post is, signed by it. The client gets it from the server the post is on ([`GET /content/:contentId/attestation`](#attestations) there, which needs no key), and sends it on as it is, in `origin`:

```json
{ "userId": "...", "apiKey": "...", "tags": ["travel"],
  "origin": { "attestation": "eyJ2IjoxLCJraWQiOiI…" } }
```

| field | notes |
| --- | --- |
| `origin.attestation` | Required: the attestation, exactly as the post's own server gave it, at most 600,000 characters. It says the original's address there, who published it, its content type, its AI declaration and its [preview](#previews), and the instance takes all of that from it. |

The original's address, publisher and summary aren't fields of the request: what a client says of the post itself isn't taken. An `origin` without an `attestation` gets `400`.

The instance checks the attestation before it uses anything in it, whether or not it has the original already. Nothing is reposted if it's refused:

| Status | When |
| --- | --- |
| `400` | It isn't written as an attestation, or doesn't say what one says of a post: `details` names the part. The original's address must end in `/content/<contentId>`, with no query, fragment or credentials. |
| `400` | It was signed more than 10 minutes ago, or by a clock more than a minute ahead of the instance's. Get a new one, and send it straight away. |
| `400` | The original's address isn't an `https` one, or names a port: a server's keys are asked for on the port `https` has (443), and on no other. |
| `400` | It says the post is gone ([below](#attestations)): there's nothing to repost. |
| `400` | It isn't signed with a key of the server at the address it names. A server signs only for its own address, so an attestation made up by a client, changed on the way, or signed by another server, is refused here. |
| `400` | It's signed, and says of an image, a video or an audio no content type of that kind. |
| `502` | The original's server didn't give its keys, so the signature couldn't be checked. The instance doesn't ask that server again for a minute. |
| `429` | Your reposts had the instance ask other servers for their keys more than 10 times in a minute. `Retry-After` says when to try again. Reposts from servers whose keys the instance already has aren't counted. |

To check the signature, the instance asks the original's server for its public keys ([`GET /repost/keys`](#attestations) there, over `https`, on port 443), and keeps them for 3 hours. That's the one request a repost has an instance make of another server: everything else of a repost between servers is carried by the client. Later, the instance asks the original's server for the post's attestation again by itself, about once a day ([below](#refreshing-a-repost)). When an attestation names a key the instance doesn't have, it asks again, at most once a minute. So an attestation signed with a key its server has just changed to can be refused (`400`) for up to a minute.

An original that is itself a repost of a post elsewhere isn't its server's to attest: `GET /content/:contentId/attestation` answers `409` for it, with the address of the post it reposts in `origin.url`. Ask that post's server instead, so a post has one address wherever it's reposted from.

The first repost of an original makes the instance's entry for it: a post of the reposter's that is a link to the original, with the original's summary.
- **It's a new post, and passes what a new post does.** Its type must be one the instance [takes](#post-store) (`400`). It's [moderated](#moderation): it gets a trust score from what there is of it to read (the preview's text or link, the original's address, its publisher's name), which can refuse it (`422`) or hold it in the [moderation queue](#the-moderation-queue), and its hashtags follow their rules. It's a post as far as the [limit on posts a minute](#limits-on-posts-and-comments) goes.
- **The response** is `201` with `{ contentId, tags, preview, aiGenerated, origin }`, plus `removedTags` when moderation dropped some of its hashtags, or `202` with `status: "pending_review"` beside them when it's held. `contentId` is the entry's id here, and `preview` is the original's, as its server attested it, cut to this instance's [preview](#previews) length.
- **It shows like any post, with `origin`.** Feed records and `GET /content/:contentId` carry `origin: { url, publisher: { userId, username } }`: the original's address, and who published it there. Their `publisher` is the user who reposted it here, whose post the entry is. `GET /content/:contentId` adds `origin.attestedAt`: when the original's server signed what is shown.
- **Show the original's server beside its publisher's name.** `origin.publisher.username` is a name on the server at `origin.url`, and nothing more. The attestation says that server said it, not who the person is: anyone can run a server and attest posts under any name, one that is somebody's on this instance among them. So show the host of `origin.url` with the name (`Dana of the North` on `other.example`), never the name alone. And `origin.publisher.userId` is an id on that server: don't link it to a user of this instance, or show it as one.
- **Its bytes stay where the original is.** An image's, video's or audio's `preview.url` is the original's, `<origin.url>/raw`, and `GET /content/:contentId/raw` redirects there (`302`). An album's other images are there too, at `<origin.url>/raw/<n>`, where `GET /content/:contentId/raw/<n>` redirects, and its `preview.imageCount` says how many there are. Its images' [alt texts](#alt-text) come with the preview, in `alt`. A [processed video](#videos)'s poster and stream are the original's too: `preview.video.poster` and `preview.video.hls` are addresses on the original's server, and `GET /content/:contentId/video/:videoId/:file` redirects there. `GET /content/:contentId` has no `size` for it, no whole `text`, and no `images`.
- **It takes no comments, and has no update** (`400`): what it shows is the original's. Its owner deletes it like any post.
- **The summary is the original's server's word, as of `origin.attestedAt`.** The instance checks who signed it, and never reads the original. So an edit or a deletion there shows here once the instance has a [later attestation](#refreshing-a-repost) of the original, which it asks that server for about once a day and which anybody can bring sooner; until then the entry says what the post was. And a server is free to say what it likes of its own posts. An image's, video's or audio's bytes aren't signed: they're read at the original's address.

An instance holds one entry per original, however many users repost it:
- **A repost of an original the instance already has an entry for is a repost of that entry,** exactly as if it had named the entry's `contentId`: it gives the entry hashtags, shows it to the reposter's followers, and is answered as [above](#post-repost), with `repostedAt`. The user who made the entry has reposted the original already (`409`).
- **While the entry waits in the moderation queue, or is set for deletion,** the original can't be reposted (`409`). Once it's deleted, the next repost makes a new entry.
- **While the entry is hidden because the original was gone** ([below](#refreshing-a-repost)), a repost's attestation is first taken as a refresh, which brings the entry back, and the repost is then made of it. It can be refused as a refresh can, and gets `409` if what the post now says is held in the moderation queue.
- **An address on this instance** names a post of its own, and is reposted as one, as if by its `contentId`. Its attestation is this instance's own, and is checked with this instance's own keys.

An instance can refuse reposts of posts on other servers alone (`REPOSTS_REMOTE=false`): they get `400`, and reposts of its own posts stay on.

The [CLI](CLI.md) does both steps with `evieverse repost https://other.example/content/<contentId> --tags travel`: it gets the post's attestation from the other server, and sends it here.

#### Refreshing a repost

An instance's entry for a post on another server holds the original's summary as it was when it was last attested. It learns what the original became from a later attestation, which reaches it in two ways:

- **The instance asks for one itself,** every 24 hours for each entry (`REPOSTS_REFRESH_HOURS`; `0` turns it off): [`GET /content/:contentId/attestation`](#attestations) on the original's server. So an edit or a deletion of the original shows here within about a day with no client doing anything. While an entry is hidden because the post was gone, it asks every 6 hours.
- **A client brings one sooner,** with `POST /repost/refresh`: it asks the original's server for the attestation, and sends what it got here, as a repost sends it. A client that shows a repost can compare `origin.attestedAt` with how fresh it wants it, and do this when it's older.

Either way the instance does the same with it. The request:

```json
{ "userId": "...", "apiKey": "...", "origin": { "attestation": "eyJ2IjoxLCJraWQiOiI…" } }
```

Authenticated. Any user can send it, not only those who reposted the original: it's the original's server that says what the post is, and the user only carries its word. A [banned](#bans) user is refused (`403`).

What to send is whichever the original's server gave:
- **Its `attestation`,** if the post is there (`200`). The entry takes the post's summary as it is now: its publisher's name there, its AI declaration and its preview.
- **Its `gone`,** if the post isn't (`404` there, with `gone` beside the `error`). It's sent in `origin.attestation` like the other, and has the entry hidden, not deleted.

The attestation is [checked as a repost's is](#a-post-on-another-server), with the same refusals, except that one which says the post is gone is taken. Then:

| Status | When |
| --- | --- |
| `200` | The entry was brought up to date: `{ contentId, tags, preview, aiGenerated, origin }`, plus `removedTags` when what it now says cost it hashtags. |
| `200` | It says what the entry says already: `{ contentId, unchanged: true }`. Nothing was written. |
| `200` | It says the post is gone: `{ contentId, status: "origin_gone", goneAt, deleteAfter }`. The entry is hidden (below). For an entry that was hidden already, `unchanged: true` comes with it, and `goneAt` is still when it was first hidden. |
| `202` | What it now says is held in the [moderation queue](#the-moderation-queue): `status: "pending_review"` beside the fields of a `200`. The entry is out of the feeds until it's accepted. |
| `400` | The attestation's address is on this instance: there's nothing to refresh of its own posts. |
| `400` | It says the post is of another content type than the entry's. A post keeps its type, and the entry stays as it was. |
| `404` | The instance has no entry for that original, or one that is set for deletion already. |
| `409` | It was signed no later than the attestation the entry is from (`origin.attestedAt`), or than one that was written to the entry as this one arrived. So an attestation somebody kept doesn't bring back what the post was, and of two sent at once the later one stays. |
| `422` | What it now says is something the instance doesn't trust enough to keep. The entry stays as it was. |
| `429` | Your refreshes changed entries more than 10 times in a minute. `Retry-After` says when to try again. One that changes nothing isn't counted. |

- **What the entry now says is [moderated](#moderation) as an update of a post is,** in the name of the entry's owner: it gets a trust score, and its hashtags are held to their rules. A hashtag whose blocked words it now has comes off it, one a repost gave it too, and is listed in `removedTags`.
- **It shows as an update does:** `GET /content/:contentId` has it at once, with the new `origin.attestedAt`, and the feeds after the compactor's next run. The entry stays its owner's post, where it was, with the hashtags reposts gave it.
- **A post that's gone has its entry hidden, and deleted only if it stays gone.** A server signs `gone` for whatever it doesn't publish at an address, which includes a post whose update waits in its moderation queue, so it's no proof that the post was deleted.
  - **Hidden** is as a post that waits in the moderation queue is: `404` to everyone but its owner, server moderators and admins, in no feed, and not to be liked or reposted. The entry keeps its hashtags, the ones reposts gave it too. [`GET /content/:contentId`](#get-contentcontentid) shows it to those three with `status: "origin_gone"`.
  - **A later attestation of the post brings it back** where it was, with all its hashtags, once the compactor has run. It's moderated like any refresh, so it can come back held (`202`).
  - **After 7 days hidden** (`REPOSTS_GONE_DAYS`) with no such attestation, the instance deletes the entry, as [`DELETE /content/:contentId`](#delete-contentcontentid) would: that's `deleteAfter`. The days count from `goneAt`, whatever `gone` attestations arrive later. Once it's deleted, the original can be reposted anew if it's there again.
- **Nobody is told.** The entry's owner gets no notice when it's changed, hidden or deleted this way.
- **An original's server that doesn't answer changes nothing.** When the instance asks and gets no attestation it can check (the server is down, or answers with nothing signed), the entry stays as it is, and that server is asked again an hour later. Only a signed `gone` hides an entry.
- **An instance that takes no reposts of posts on other servers** (`REPOSTS_REMOTE=false`, or `REPOSTS=false`) takes no refreshes from clients either (`400`). It still asks after the entries it has, unless `REPOSTS_REFRESH_HOURS=0`.

#### Attestations

Two requests serve reposts between servers. Neither needs a key.

`GET /content/:contentId/attestation` returns a post as the instance signs it, for a client to send to another server with [`POST /repost`](#a-post-on-another-server):

```bash
curl localhost:3000/content/$CONTENT_ID/attestation
```

```json
{ "attestation": "eyJ2IjoxLCJraWQiOiI….k3VwR2…" }
```

- **Ask for it when you use it.** It's signed as of the request, and other servers take it for 10 minutes. It comes with `Cache-Control: no-store`.
- **Send it on whole.** A client has no need to read it, and a change to it makes the signature wrong.
- **Only a published post has one.** A post that isn't there, is set for deletion, or waits in the [moderation queue](#the-moderation-queue) gets `404`, to its publisher too. So does a new post whose video is still being [processed](#videos); a post whose update is being processed is attested as it was before the update.
- **The `404` is signed too.** Beside its `error` it has `gone`: an attestation that says there's no post at the address, which the servers that hold a repost of one that was read when they ask, and a client can send them sooner ([`POST /repost/refresh`](#refreshing-a-repost) there). It's the same for all three, so it says no more than the `404` does. That's why those servers hide their repost on it and don't delete it: a post that an update sent to the moderation queue is hidden there while it waits, and is back once it's accepted and attested again.
- **One address can ask for 60 attestations a minute** (`REPOSTS_ATTESTATION_RATE_LIMIT_PER_MINUTE`), then gets `429` ([below](#limits-on-reads-that-need-no-key)). A server that asks after the posts it holds reposts of sends at most 30 a minute.
- **Only a post that is the instance's own has one.** Its entry for a [post on another server](#a-post-on-another-server) gets `409`, with `origin: { url }` beside the `error`: the address of the original, whose server is the one to ask.
- **An instance that signs nothing gives none** (`400`): one with no signing key (`REPOSTS_SIGNING_KEYS`), or no address of its own (`PUBLIC_BASE_URL`). Its posts are reposted only on the instance itself, and its `404` has no `gone`. It still takes reposts of posts on servers that sign.
- **An instance whose address names a port** (`PUBLIC_BASE_URL=https://api.example.com:8443`) signs attestations that other servers refuse: they ask for keys on port 443 only.

An attestation is two parts in base64url with a dot between them: a JSON payload, and its Ed25519 signature. The payload:

```json
{ "v": 1, "kid": "9f2c4e1a7b3d5c60", "issuedAt": 1794319320000,
  "url": "https://other.example/content/0b7c0f5e-…",
  "publisher": { "userId": "…", "username": "Bob" },
  "mimeType": "image/jpeg", "aiGenerated": false,
  "preview": { "kind": "image", "text": "Sunrise over the harbour" } }
```

| field | notes |
| --- | --- |
| `v` | The format's version: `1`. |
| `kid` | The id of the key that signed, which is one of those `GET /repost/keys` lists. |
| `issuedAt` | When it was signed, in milliseconds since the Unix epoch, by the instance's clock. |
| `url` | The post's address on the instance: its `PUBLIC_BASE_URL`, then `/content/<contentId>`. |
| `publisher` | `{ userId, username }`: who published the post here. |
| `mimeType`, `aiGenerated` | The post's content type and AI declaration. |
| `preview` | The post's [preview](#previews). An image's, video's or audio's has its caption, if it has one, and no `url`: the file is read at the post's address. An album's has `imageCount`, how many images it has (2 or more): the first is read at `<url>/raw`, the others at `<url>/raw/<n>`. An instance takes an `imageCount` of up to 100 from another server. An image post whose images are described has `alt`, as its preview does: an instance takes up to 5,000 characters for each from another server. A [processed video](#videos)'s has `video: { id, width, height, duration }`, without the addresses of its poster and stream: they're read at `<url>/video/<id>/poster.jpg` and `<url>/video/<id>/master.m3u8`. |

The one that says there's no post has `gone` in place of everything about a post:

```json
{ "v": 1, "kid": "9f2c4e1a7b3d5c60", "issuedAt": 1794319320000,
  "url": "https://other.example/content/0b7c0f5e-…", "gone": true }
```

What is signed is the payload's part exactly as it's written, in base64url, after the prefix `evieverse-repost-attestation-v1.`.

`GET /repost/keys` returns the public keys the instance signs with, which is what other servers check its attestations by:

```json
{ "keys": [{ "id": "9f2c4e1a7b3d5c60", "publicKey": "…", "algorithm": "ed25519" }] }
```

- `publicKey` is the key's 32 bytes in base64url, and `id` the first 16 hex digits of their SHA-256. A server that reads the list works the id out from the key itself, and takes the first 16 keys of it.
- The first key is the one that signs now. An instance that is changing its key lists the old one after it for a while, so that what the old one signed is still taken.
- An instance that signs nothing returns `{ "keys": [] }`.

### `POST /like`

```json
{ "userId": "...", "apiKey": "...", "contentId": "..." }
```

Each user can like a piece of content once, and the like stays until they take it back ([`DELETE /like`](#delete-like)). Returns `{ contentId, likes, alreadyLiked }`: `201` for a first like, and `200` with `alreadyLiked: true` for a repeated one, which doesn't count twice. Likes show up in feeds after the next compactor run. Content set for deletion, or waiting in the [moderation queue](#the-moderation-queue), can't be liked (`404`). A [banned](#bans) user is refused (`403`), for content they liked before the ban too: that like stays, until they take it back.

**Liking a comment.** With `commentId` as well, the like is of that [comment](#comments) on the post, not of the post:

```json
{ "userId": "...", "apiKey": "...", "contentId": "...", "commentId": "..." }
```

It returns `{ contentId, commentId, likes, alreadyLiked }`, with the same two statuses, and a comment's likes are once per user too, and stay until they're taken back. `likes` is the comment's, with this like counted. Every record of the comment gives the number as well, with this like in it after the compactor's next run. The comment must be published, on a published post that takes comments: one that isn't there gets `404`, and so does one that waits in the moderation queue, or a [placeholder](#placeholders). A comment's likes go with it when it's deleted.

### `DELETE /like`

```json
{ "userId": "...", "apiKey": "...", "contentId": "..." }
```

Authenticated. Takes back the user's like of a post. Returns `200` with `{ contentId, likes, wasLiked }`: `likes` is the post's count now, and `wasLiked` is whether there was a like to take back. Taking back a like that isn't there changes nothing, and is answered the same way, with `wasLiked: false`. The user can like the post again afterwards ([`POST /like`](#post-like)), which is a new like.

A client that sends no body with a `DELETE` names the post in the query instead, with its credentials in the [headers](#authentication):

```sh
curl -X DELETE "localhost:3000/like?contentId=$CONTENT_ID" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

- **The post has the new count at once** ([`GET /content/:contentId`](#get-contentcontentid)). Feeds show it, and the order it makes, after the next compactor run.
- **Where a [repost](#post-repost) placed the post,** that record's `likes` are the ones since the repost. Taking back a like that was made before the repost leaves that number as it was.
- **Content set for deletion** gets `404`: its likes go with it.
- **Content that's withheld from readers,** because it waits in the [moderation queue](#the-moderation-queue) or its original is [gone from its own server](#refreshing-a-repost), still gives back a like to the user who has one there. Anyone else gets `404`, as from `POST /like`.
- **A [banned](#bans) user isn't refused:** the like is theirs to take back.

**Taking back a like of a comment.** With `commentId` as well, in the body or in the query, the like is the user's of that [comment](#comments):

```json
{ "userId": "...", "apiKey": "...", "contentId": "...", "commentId": "..." }
```

It returns `{ contentId, commentId, likes, wasLiked }`. `likes` is the comment's, without this like. Every record of the comment gives the number as well, without the like after the compactor's next run. A comment that was deleted gets `404`, and so does one under a post set for deletion. Where `POST /like` would refuse the comment for another reason (its post is withheld or no longer takes comments, or an edit took the comment back to the moderation queue), a user who has a like there can still take it back, and anyone else gets the `404` that `POST /like` gives.

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

It returns `{ contentId, commentId, reportedAt, alreadyReported }`, and everything above applies to the comment as it does to a post: one report per user, the comment stays published while it waits in the report queue, and its author isn't told. A comment that isn't there gets `404`, and so does one that waits in the moderation queue, a [placeholder](#placeholders), or one on a post that doesn't take comments. A post's reports and its comments' are apart, and both count towards the same limit of reports an hour.

## Comments

A post takes comments if its publisher turned them on: the `comments` field of [`POST /store`](#post-store), which is off unless they say, and which they can change with an update. `GET /content/:contentId` and every feed record say whether a post takes them, as `comments`.

- A comment is a text of up to 2,000 characters, an image or a video, or a text with one of the two. Its text can be formatted, as a post's can ([TEXT_EDITORS.md](TEXT_EDITORS.md)).
- A comment is on the post itself, or replies to another comment on it, at any depth. So a post's comments are a tree, which is read a level at a time: the comments on the post, then the replies to whichever of them a reader opens.
- A comment's author can [edit](#patch-contentcontentidcommentscommentid) its text, and any user can [like](#post-like) a comment, once, and [take the like back](#delete-like).
- A comment's author declares whether it was created with AI (`aiGenerated`), as a post's publisher does of a post: `false` unless they say so, and theirs to change with an edit. Every comment's record says it.
- Anyone who can read the post can read its comments, with no key. Any user can comment.
- Comments go through [moderation](#moderation) as posts do: the same trust score and thresholds refuse a comment, hold it in [the moderation queue](#the-moderation-queue), or publish it, and an edit is scored as a new comment is. Users can [report](#post-report) a published comment, which puts it in [the report queue](#the-report-queue).
- New comments and edits are [limited](#limits-on-posts-and-comments) as posts are, with a number of their own: past 10 in a minute they're refused.
- A comment is deleted alone. The comments that reply to it stay, under a [placeholder](#placeholders) left in its place.
- A post that doesn't take comments answers every endpoint here but `DELETE` with `404`, "this post doesn't take comments", and so does a like or a report of one of its comments. If it had comments before its publisher turned them off, they're kept, and are back when comments are turned on again.
- A post's comments are deleted with the post.

A comment is:

```json
{ "commentId": "0199c2f5-0a3c-7000-8e21-77d0b4a9c613", "contentId": "...", "parentId": null,
  "author": { "userId": "...", "username": "carol" },
  "text": "Same spot, an hour later.", "aiGenerated": false,
  "media": { "kind": "image", "url": "/content/…/comments/0199c2f5-…/raw", "mimeType": "image/jpeg", "size": 48211 },
  "likes": 3, "replies": 1,
  "createdAt": "2026-11-10T14:03:10.000Z", "editedAt": null }
```

| field | notes |
| --- | --- |
| `commentId` | Its id. A post's comment ids sort in the order the comments were sent. |
| `contentId` | The post it's on. |
| `parentId` | The comment it replies to, or `null` for a comment on the post itself. |
| `author` | The user's current credit, as a post's `publisher` is. `null` on a placeholder. |
| `text` | What it says. Empty for a comment that is only its image or video. |
| `mentions` | The users the text [mentions](#mentions): `[{ userId, username }]`. Not there on a comment that mentions nobody, nor on a placeholder. |
| `aiGenerated` | Its author's declaration of whether the comment was created with AI, as a post's publisher makes of a post: `true` or `false`. Nothing detects or checks it. `false` on a placeholder. |
| `media` | The image or video it came with: its `kind` (`image` or `video`), the `url` its bytes are read at, its `mimeType` and its `size` in bytes as stored. An image its author described has `alt`, its [alt text](#alt-text). `null` for a comment that is only text. The `url` is absolute where the instance sets `PUBLIC_BASE_URL`. |
| `processing` | `true` on a comment whose video is still being [processed](#post-contentcontentidcomments). Not there otherwise. |
| `likes` | How many users liked it. |
| `replies` | How many comments reply to it: to it, not to its replies. |
| `createdAt` | When it was sent. An edit doesn't change it. |
| `editedAt` | When its author last edited it (changed its text, or its `aiGenerated`), or `null` if they never did. |
| `status` | Not there on a published comment. `"pending_review"` on one that waits in the moderation queue, and on a placeholder `"deleted"`, `"pending_review"` or `"blocked"` (below). |

#### Placeholders

A comment that something replies to can't just go, or its replies would be under nothing. So two things leave a placeholder in a comment's place:
- **Deleting a comment that has replies**, whoever deletes it: `status: "deleted"`.
- **An edit that's held**, which takes a published comment back to the moderation queue until it's decided on: `status: "pending_review"`.

A placeholder is returned as a comment is, in the lists and by its id, where the comment was: the same record with `author: null`, `text: ""`, `aiGenerated: false`, `media: null`, `likes: 0` and `editedAt: null`, with the comment's `replies`, and with the `status`. A client shows it as a gap with the replies under it. It isn't a comment: replying to it, liking it, reporting it, editing it or deleting it gets `404`, as for a comment that isn't there. The replies under it are read, liked and replied to as before.

A deleted comment that nothing replies to leaves no placeholder, and the placeholder of a deleted comment goes once the last reply to it is deleted.

**`status: "blocked"` is a placeholder of another sort.** The comment is there, and published: the two lists give it so to a reader who [blocks](#blocks) its author, and to nobody else. It has the same shape (`author: null`, `text: ""`, `aiGenerated: false`, `media: null`, `likes: 0`, `editedAt: null`, no `mentions`), and keeps the comment's place and its `replies`, so the replies under it are read as before. Only a request that sends the reader's own credentials in the headers gets it: without them the lists give the comment as it is, and so does reading it by its id, with credentials or without. It's counted as the comment it stands for.

### Reading comments

`GET /content/:contentId/comments` returns a page of the comments on the post itself, and how many comments the post has in all:

```json
{ "contentId": "...", "count": 3, "nextCursor": null, "comments": [
  { "commentId": "0199c2f4-7b1e-7000-9c5d-2f6a1c3b4d5e", "contentId": "...", "parentId": null,
    "author": { "userId": "...", "username": "bob" },
    "text": "First!", "aiGenerated": false, "media": null, "likes": 0, "replies": 0,
    "createdAt": "2026-11-10T14:02:00.000Z", "editedAt": null },
  { "commentId": "0199c2f5-0a3c-7000-8e21-77d0b4a9c613", "contentId": "...", "parentId": null,
    "author": { "userId": "...", "username": "carol" },
    "text": "Lovely light.", "aiGenerated": false, "media": null, "likes": 3, "replies": 1,
    "createdAt": "2026-11-10T14:03:10.000Z", "editedAt": "2026-11-10T14:05:42.000Z" }
] }
```

`GET /content/:contentId/comments/:commentId/replies` returns a page of the replies to one comment, in the same form with the comment's `commentId` beside `contentId`. A client asks for it when a comment's `replies` says it has some, and again for any reply that has replies of its own. It works for a placeholder too, and is `404` for a comment that isn't there or was never published.

Both take:
- `order`: `oldest` (the default) returns the comments in the order they were sent, and `newest` the other way round.
- `limit`: the most comments in the page, 50 by default and at most 100.
- `cursor`: the previous page's `nextCursor`, which is the `commentId` of the last comment on that page. The next page starts just after it, so pages never repeat a comment or skip one, whatever is added or deleted meanwhile. A cursor doesn't expire.

What they count and list:
- A post's `count` is every published comment on it, replies included, not just the ones on the page or at that level. A reply list's `count` is the replies to that comment alone, not the replies to those.
- A placeholder is listed, and counted, as the comment it stands for.
- A comment that waits in the moderation queue is in neither a list nor a count, unless it was published before: then its placeholder is.
- **The lists and the counts show what the compactor has written.** A new comment, an edit, a like or its taking back, a deletion and a moderator's decision are in the lists, in `count` and `replies`, and in a listed record's `likes`, after the [compactor](APP.md#8-the-compactor)'s next run: `COMPACT_INTERVAL_SECONDS` later at most (5 by default), plus the time the run takes. Until then they show the comments as they were. A client that wants a new comment in the list at once puts the record the request returned there itself.

`GET /content/:contentId/comments/:commentId` returns one comment, or the placeholder in its place, as it is with every write the server has answered: a new comment can be read this way at once, an edit shows at once, and a deleted comment is gone at once, or is its placeholder if it has replies. A comment that waits in the [moderation queue](#the-moderation-queue) is returned whole, with `status: "pending_review"`, to its author, to server moderators and to admins, who send their credentials in the headers (`Authorization: Bearer <apiKey>` and `X-User-Id`). Anyone else gets `404` for it, or its placeholder if it was published before an edit took it back to the queue.

`GET /content/:contentId/comments/:commentId/raw` returns the bytes of the image or video a comment came with, as [`GET /content/:contentId/raw`](#get-contentcontentid) returns a post's: streamed with their content type and the same headers, or a redirect to a presigned URL on stores that support them. Whoever can read the comment can read its file. A comment that is only text gets `404`, and so does a placeholder, and a comment whose video is still being processed.

All four return `404` for a post that isn't there, is set for deletion, or doesn't take comments. A post that waits in the moderation queue is `404` too, except to those who can read it there ([`GET /content/:contentId`](#get-contentcontentid)), and nobody can comment on it until it's accepted.

One address can ask for 120 pages a minute of each of the two lists (`COMMENTS_LIST_RATE_LIMIT_PER_MINUTE`), then gets `429` ([below](#limits-on-reads-that-need-no-key)). Reading one comment, and its file, isn't limited.

```bash
curl "localhost:3000/content/$CONTENT_ID/comments?order=newest&limit=20"
curl "localhost:3000/content/$CONTENT_ID/comments/$COMMENT_ID/replies"
```

### `POST /content/:contentId/comments`

```json
{ "userId": "...", "apiKey": "...", "text": "Lovely light." }
```

Comments on a post, or with `parentId`, replies to a comment on it. Send it as JSON, or as `multipart/form-data` with the file in a part named `content`, as a post is sent to [`POST /store`](#post-store). The post must be published and take comments, otherwise `404`. A [banned](#bans) user is refused (`403`), and so is a user the post's publisher [blocks](#blocks): "this post's publisher doesn't take comments from you".

| field | notes |
| --- | --- |
| `text` | What the comment says: at most 2,000 characters, trimmed of leading and trailing whitespace. It can be [formatted](TEXT_EDITORS.md). Optional for a comment that comes with a file. A comment with neither gets `400`. |
| `parentId` | Optional: the `commentId` of the comment this one replies to, at any depth. It must be a published comment on the same post: one that isn't there, waits in the moderation queue or is a [placeholder](#placeholders) gets `404`. |
| `aiGenerated` | Optional. The author's declaration that the comment was created with AI: `true` or `false` (a JSON boolean, or the string in a form field), as [`POST /store`](#post-store) takes a post's. Defaults to `false`. It's returned on the comment wherever the comment is, and its author can change it with an [edit](#patch-contentcontentidcommentscommentid). |
| `content` | Optional: the comment's image or video, as a file part (multipart), or a string in JSON with `contentEncoding: "base64"` (a JSON request can be at most 32 MB). One file at most. A file larger than `MAX_UPLOAD_BYTES` (5 GiB) gets `413`. |
| `uploadId` | In place of `content`: a file already sent with an upload link from [`POST /uploads`](#post-uploads). Not together with `content` (`400`). The upload is kept until the comment is stored, so a comment that's refused for being past the comments a minute (`429`) is sent again with the same `uploadId`. |
| `contentType`, `filename` | Optional hints for the file. Otherwise its content type comes from the upload or the file extension. It must be `image/*` or `video/*`: anything else gets `400`, audio included. |
| `alt` | Optional: the [alt text](#alt-text) of the comment's image, at most 1,500 characters. Only with an image (`400` otherwise). It's returned as `media.alt`, and moderated as the comment's text is. |

The file is held to what an image or video post's is: an image is a JPEG, PNG, GIF or WebP, told by its bytes and stored [without its metadata](#images), and a video is processed (below). A server that has [turned off](#post-store) image or video posts takes no file of that type with a comment either (`400`); a comment's text is taken whether text posts are on or off. A comment's file can't be changed afterwards, and goes when the comment does.

A comment's video is processed as a [post's](#videos) is, where the server processes videos, with less made of it:

- **It's made one MP4** of H.264 and AAC, at most 720 pixels on its shorter side (`VIDEO_COMMENT_HEIGHT`), without its metadata. It has no stream and no poster.
- **The response has `processing: true`,** and so has the comment read by its id, until the video is ready. Its `/raw` answers `404` until then, and `media.mimeType` and `media.size` are the file's as it was sent.
- **The comment is in the [lists](#reading-comments) once the video is ready,** with `media.mimeType` `video/mp4`.
- **A video that can't be processed is dropped.** The comment is published with its text alone, or not at all if the video was all of it, and its author gets a [notice](#notices).

The response is the comment:

| Status | What happened |
| --- | --- |
| `201` | The comment is published. It can be read by its id at once, and is in the post's [lists and counts](#reading-comments) after the compactor's next run. |
| `202` | The comment is held in the [moderation queue](#the-moderation-queue), and has `status: "pending_review"`. Only its author, server moderators and admins can read it until one of them accepts it. |
| `422` | The server doesn't trust the comment enough to keep it: nothing is stored. With the default thresholds, that's a comment containing a word or phrase [the server blocks](#blocked-words). |
| `429` | The user sent 10 comments in the last minute (`COMMENTS_PER_MINUTE`), edits among them. Nothing is stored, and the response says when to try again, in a `Retry-After` header and as `retryAfterSeconds`. |

A comment is checked by [moderation](#moderation) first, then against the 10 a minute ([above](#limits-on-posts-and-comments)). Only comments that were published or held count towards them: one that's refused, or that fails, doesn't. Comments don't count towards the posts a user can send in a minute. Comments claim their place atomically, in Redis: of several sent at once, no more get through than the limit allows.

```bash
curl -X POST "localhost:3000/content/$CONTENT_ID/comments" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d "{ \"text\": \"Where was this taken?\", \"parentId\": \"$COMMENT_ID\" }"
curl -X POST "localhost:3000/content/$CONTENT_ID/comments" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F text="Same spot, an hour later." -F content=@harbour.jpg
```

### `PATCH /content/:contentId/comments/:commentId`

```json
{ "userId": "...", "apiKey": "...", "text": "Lovely light, and a lovely boat." }
```

Edits a comment: its author gives it another text. Nobody else can, an admin included (`403`). `text` is required, at most 2,000 characters and trimmed, and replaces the text the comment has. `aiGenerated` is optional: the author's declaration of whether the comment was created with AI, `true` or `false`.

- **An edit that leaves `aiGenerated` out keeps the comment's value.** One that says it changes it, and changing only that is an edit too: it's sent with the text the comment has, and is scored, counted and dated (`editedAt`) as any edit is.
- **Nothing else is edited.** The image or video a comment came with is neither replaced nor taken away, and a comment that came without one is given none. A comment that has a file can be left with no text (`"text": ""`); one that hasn't needs one (`400`).
- **The comment stays where it is.** It keeps its `commentId`, its `createdAt`, its place among the others, its replies and its likes. `editedAt` says when it was last edited. What it said before isn't kept.
- **The edit shows by the comment's id at once, and in the [lists](#reading-comments) after the compactor's next run.** That goes for a held edit too: the lists show the comment as it was until that run, and its placeholder from then on.
- **Of two edits sent at once, the last to commit wins.** An edit is of the comment as it is when the edit commits: one that was deleted meanwhile gets `404`, and one that another edit changed meanwhile is edited as that left it.
- **The text it already has changes nothing,** with the `aiGenerated` it has or with none sent. The response is `200` with `{ contentId, commentId, unchanged: true }`, plus `status: "pending_review"` for a comment that waits in the moderation queue. It isn't scored and isn't counted.
- **An edit counts as a comment.** It's scored by [moderation](#moderation) as a new comment is, then counted with the user's comments of the last minute ([above](#limits-on-posts-and-comments)).
- A [banned](#bans) user is refused (`403`), and so is a user the post's publisher [blocks](#blocks): they can't change what they wrote there, though they can still delete it. The post must be published and take comments, otherwise `404`. A comment that isn't there gets `404`, and so does a [placeholder](#placeholders), and a comment that waits in the moderation queue for anyone who can't read it there.

The response is the comment as it now is:

| Status | What happened |
| --- | --- |
| `200` | The comment is published with its new text, or nothing changed (`unchanged: true`). A comment that waited in the moderation queue leaves it, published with nobody's decision: its author gets no notice. |
| `202` | The edit is held in the [moderation queue](#the-moderation-queue), and the comment has `status: "pending_review"`. A published comment is taken off the post until a server moderator or an admin accepts it: only they and its author can read it, and everyone else finds a [placeholder](#placeholders) in its place, with its replies under it as before. Accepted, it's back where it was, as edited, with its replies and likes. Rejected, it's deleted. A comment that was already waiting keeps its place in the queue. |
| `422` | The server doesn't trust the new text enough to keep it. Nothing is written: the comment stays as it was. |
| `429` | The user sent 10 comments in the last minute (`COMMENTS_PER_MINUTE`), edits among them. Nothing is written, and the response says when to try again. |

```bash
curl -X PATCH "localhost:3000/content/$CONTENT_ID/comments/$COMMENT_ID" -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d '{ "text": "Lovely light, and a lovely boat." }'
```

### `DELETE /content/:contentId/comments/:commentId`

Authenticated. Deletes a comment, for good, and returns `{ contentId, commentId, status: "deleted" }`. By its id the comment is gone at once, or is its placeholder, and takes no reply, like or edit from then on; the post's [lists and counts](#reading-comments) show that after the compactor's next run. A comment that isn't there, or that another request deleted first, gets `404`. Who can:
- **Its author**, whether it's published or waits in the moderation queue.
- **The publisher of the post it's on**, if it's published. A comment that waits in the moderation queue isn't theirs to read, so it's `404` to them.
- **An admin.**

Anyone else gets `403`, a server moderator included: they [reject](#the-moderation-queue) a comment in the moderation queue, or [delete](#the-report-queue) one in the report queue. A [tag moderator](#moderation) has no say over comments.

**Only that comment is deleted**, with its likes and its image or video. The comments that reply to it stay, whoever wrote them, with their own replies and likes: they're listed under a [placeholder](#placeholders) with `status: "deleted"`, left where the comment was. A comment that nothing replies to leaves nothing. A placeholder itself can't be deleted (`404`): it goes when the last reply to it does.

When someone other than its author deletes a comment, the author gets a [notice](#notices) in their inbox. The comment's reports, and its place in either queue, go with it. This works on a post that no longer takes comments too: what was written while it did is still its author's, and the publisher's, to delete.

## Following

A user can follow other users, and read a feed of their posts alone ([`GET /feed/following`](#get-feedfollowing)).

- `PUT /users/:userId/following/:followeeId` (authenticated as `userId`) follows `followeeId`. It returns `201` with `{ userId, followeeId, followedAt, alreadyFollowing: false }`. Following someone again changes nothing, and returns `200` with `alreadyFollowing: true` and the original `followedAt`.
- `DELETE /users/:userId/following/:followeeId` (authenticated as `userId`) stops following them, and returns `{ userId, followeeId, wasFollowing }`. Unfollowing someone you don't follow changes nothing, and returns `wasFollowing: false`. If it returns `503`, the follow is gone but the following feed couldn't be updated: send the request again.
- `GET /users/:userId/following` lists whom a user follows, and `GET /users/:userId/followers` who follows them, most recent follow first: `{ userId, following: [{ userId, username, followedAt }], nextCursor }` (with `followers` in the second). They take `limit` (100 by default, at most 1,000) and `cursor`, the previous page's `nextCursor`.

Rules:
- You can only change whom you follow yourself: a path naming another user gets `403`.
- Following yourself gets `400`, and following a user who doesn't exist gets `404`.
- A follow gets `403` while either of the two [blocks](#blocks) the other. A block ends the follows there were between them, in both directions, and ending the block brings none back.
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
- **Notices** from the server, when a moderator or an admin does something to one of the user's posts or comments, or mutes them on a hashtag, when they're made a moderator of a hashtag or are one no more, when their [claim to a hashtag](#claiming-a-hashtag) is granted or refused, and when a post or a comment [mentions](#mentions) them. Admins and server moderators also get one when a user claims a hashtag, and an admin when the server finds an image of known child sexual abuse material ([below](#notices)).
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

A notice has no `from`, except the notice of a [mention](#mentions): its `from` is who wrote the post or the comment, as a message's is who sent it, and `null` once their account is gone. Its `kind` says what happened, `text` says it in the reader's [language](#get-languages), and it names the post (`contentId`) and hashtag (`tag`) it's about, where there is one. `excerpt` is the start of the post, at most 200 characters (its text or caption without its [formatting](TEXT_EDITORS.md), or a link's URL), so the publisher can tell which post it was once it's gone. A notice about a comment names the post the comment is on, and its `excerpt` is the start of the comment instead. The last two kinds of the table quote nothing, and have `details` in place of an `excerpt` ([below](#an-image-that-matches-the-servers-list)). So has `tag_claimed`, whose `details` are `{ userId, username, reviewUntil }`: who claims the hashtag, and until when the claim can be refused.

| `kind` | What happened | It has |
| --- | --- | --- |
| `post_accepted` | A server moderator or an admin accepted the post from [the moderation queue](#the-moderation-queue): it's published. | `contentId`, `excerpt` |
| `post_rejected` | They rejected it there: it's deleted. | `contentId`, `excerpt` |
| `post_deleted` | An admin deleted the post. | `contentId`, `excerpt` |
| `tag_removed` | A moderator removed a hashtag from the post. | `contentId`, `tag`, `excerpt` |
| `last_tag_removed` | A moderator removed the post's last hashtag, so the post is in no hashtag's feed any more. It can still be read. | `contentId`, `tag`, `excerpt` |
| `tag_muted` | A moderator muted the user on a hashtag. | `tag` |
| `tag_unmuted` | A moderator ended the mute. | `tag` |
| `tag_moderator_added` | An admin, or a moderator of the hashtag, made the user a [moderator of it](#a-hashtags-moderators). | `tag` |
| `tag_moderator_removed` | One of them ended the user's time as a moderator of the hashtag. | `tag` |
| `tag_claimed` | For admins and server moderators: a user [claimed a hashtag](#claiming-a-hashtag), and becomes its moderator at `reviewUntil` unless one of them refuses the claim before (`DELETE /tags/:tag/claim`). | `tag`, `details` |
| `tag_claim_granted` | The user's claim to a hashtag went through: they're a moderator of it now. | `tag` |
| `tag_claim_refused` | The user's claim to a hashtag was refused: by an admin or a server moderator, because the hashtag was given another moderator meanwhile, or because the user was banned while it waited. | `tag` |
| `comment_accepted` | A server moderator or an admin accepted the user's [comment](#comments) from the moderation queue: it's published. | `contentId`, `excerpt` |
| `comment_rejected` | They rejected it there: it's deleted. | `contentId`, `excerpt` |
| `comment_deleted` | Someone else deleted the user's comment: the post's publisher, an admin, or a server moderator or an admin from the report queue. | `contentId`, `excerpt` |
| `video_failed` | The video of a new post couldn't be [processed](#videos): the post was never published, and is deleted. | `contentId`, `excerpt` |
| `video_update_failed` | The video an update came with couldn't be processed: the post keeps the video it had, and the rest of the update is made. | `contentId`, `excerpt` |
| `comment_video_failed` | The video of the user's comment couldn't be processed: the comment is published with its text alone, or not at all if the video was all of it. | `contentId`, `excerpt` |
| `user_banned` | A server moderator or an admin [banned](#bans) the user. | |
| `user_unbanned` | They ended the ban. | |
| `post_mention` | A post that was published [mentions](#mentions) the user, in its text or caption. | `from`, `contentId`, `excerpt` |
| `comment_mention` | A comment that was published mentions the user. `contentId` is the post it's on, and `excerpt` the start of the comment. | `from`, `contentId`, `commentId`, `excerpt` |
| `csam_match_refused` | For admins, on a server that runs the `pdq` [trust plugin](#moderation): an image someone sent matches the server's list of hashes of known child sexual abuse material, and the post or comment was refused. | `details`, and `contentId` for an update or a comment |
| `csam_match_held` | The same, on a server that deletes nothing on arrival (`TRUST_SCORE_DELETE_BELOW=0`): the post or comment is stored, and waits in [the moderation queue](#the-moderation-queue). | `details`, and `contentId` for an update or a comment |

- A notice doesn't say which moderator or admin it was, and a `comment_deleted` notice doesn't say whether it was one of them or the post's publisher.
- Nobody gets a notice of what they did themselves: a moderator who removes a hashtag from their own post, say, or one who stops moderating a hashtag, or a user who withdraws their claim.
- There's no notice when a post is approved under a hashtag, or when a post or a comment is reported. A post that's refused or held when it's sent has that in the response to `POST /store`, not in a notice, and likewise a comment: whoever sent it gets no notice, whatever the admins get of it. Nor is there one for the comments that go when their post is deleted, or for a new comment on a user's post.
- Notices can't be turned off, and they don't count towards any limit. A [block](#blocks) stops one kind only: the notices of mentions between the two users.
- A client should show a `kind` it doesn't know by its `text`: later versions may add kinds.

#### An image that matches the server's list

On a server that runs the `pdq` [trust plugin](TRUST_PLUGINS.md#images-of-known-child-sexual-abuse-material), every admin gets a notice when an image of a post or of a comment, or a user's [avatar](#the-avatar), matches the server's list of hashes of known child sexual abuse material. It holds what a report to the authorities is written from, as `details`, and its `text` says the same in words:

```json
{ "messageId": "...", "kind": "csam_match_refused",
  "details": {
    "userId": "...", "username": "mallory", "at": "2026-11-10T14:02:00.000Z",
    "ip": "203.0.113.7", "userAgent": "curl/8.7.1", "sentAs": "post",
    "filename": "photo.jpg", "mimeType": "image/jpeg", "sha256": "<64 hex>",
    "pdq": "<64 hex>", "quality": 100, "listed": "<64 hex>", "distance": 4, "frame": 0,
    "outcome": "refused" },
  "text": "An image that mallory sent matches this server's list of hashes of known child sexual abuse material. It was refused: …",
  "sentAt": "2026-11-10T14:02:00.000Z", "readAt": null }
```

| In `details` | What it is |
| --- | --- |
| `userId`, `username` | Who sent the image. |
| `at` | When. |
| `ip`, `userAgent` | The address the request came from, as the server counts it, and its User-Agent header, cut at 160 characters. `userAgent` is absent if the request had none. |
| `sentAs` | `post`, `update`, `comment` or `avatar`. For an update, `contentId` is the post it would have updated, and for a comment, the post it was on, in `details` and on the notice itself. An avatar has none. |
| `filename`, `mimeType` | The image's name, cut at 160 characters and absent if it had none, and its type. |
| `sha256` | The SHA-256 of the image as the server would store it: without its metadata, so not that of the file as it was sent. |
| `pdq`, `quality` | The image's PDQ hash, and how much there is in the picture to tell it by, from 0 to 100. |
| `listed`, `distance` | The hash of the list it matched, and in how many of their 256 bits the two differ. |
| `frame` | Which frame of an animated image matched, from 0. 0 for a still image. |
| `outcome` | `refused` or `held`, as the notice's `kind` says. An avatar is always `refused`. |

- The server reports the match to nobody, and keeps no copy of a refused image: the notice and the server's log are what there is of it. Notices are deleted after `INBOX_RETENTION_DAYS` like any other.
- An admin who has an unread notice of the same user and the same listed hash gets no second one, however often the image is sent. Marking it as read, or deleting it, lets the next one arrive.
- Every admin gets it, one who sent the image too.

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

A user can block other users. With a block between two users:

| What | With the block |
| --- | --- |
| Messages | None goes between them, in either direction: [`POST /messages`](#post-messages) gets `403`. Messages that already arrived stay in the inbox. |
| Follows | Neither follows the other. The block ends the follows there were, in both directions, and a new one gets `403` while it stands: "you blocked this user: unblock them to follow them" for the one who blocked, and "you can't follow this user" for the one who is blocked. |
| Comments | The blocked user can't [comment](#comments) on the blocker's posts, nor edit the comments they made there: `403`, "this post's publisher doesn't take comments from you". This one goes one way: the blocker can still comment on the blocked user's posts. Comments made before the block stay, and their author can still delete them. |
| Mentions | Neither gets the notice of a [mention](#mentions) by the other. The text mentions them all the same, and links to their profile. |
| Reading | What the blocked user wrote is left out of what the blocker is listed: their [following feed](#get-feedfollowing), and the [lists of a post's comments](#reading-comments), which give a blocked user's comment as a placeholder with `status: "blocked"`. |

- `PUT /users/:userId/blocked/:blockedId` (authenticated as `userId`) blocks `blockedId`. It returns `201` with `{ userId, blockedId, blockedAt, alreadyBlocked: false }`, or `200` with `alreadyBlocked: true` and the original `blockedAt` if they were already blocked. If it returns `503`, the block is made and the follows between the two are gone, but the following feeds couldn't be updated: send the request again.
- `DELETE /users/:userId/blocked/:blockedId` ends the block, and returns `{ userId, blockedId, wasBlocked }`. From then on messages, follows and comments go as between any two users. It brings back no follow that the block ended.
- `GET /users/:userId/blocked` lists whom the user blocks, most recently blocked first: `{ userId, blocked: [{ userId, username, blockedAt }], nextCursor }`. It takes `limit` (100 by default, at most 1,000) and `cursor`.

Blocks are private, and there's no setting that shows them: all three need the user's own key, and a path naming another user gets `403`. Blocking yourself gets `400`, and blocking a user who doesn't exist gets `404`. The blocked user isn't told: what they can see of it is the `403` when they follow, write or comment. Admins and moderators can be blocked like anyone, which stops their messages but not the server's notices.

**Reading goes by who asks.** The feeds and the lists of comments need no key, and a block is nobody's to know but the user who made it. So nothing is left out for a request without credentials: only a request that sends a user's own credentials in the headers (`Authorization: Bearer <apiKey>` and `X-User-Id`) is held to that user's blocks. One with a wrong key is answered as one with none, not with `401`.

- **What is read by its id is given as it is:** a post, a comment, a comment's file, a profile. A blocked user still reads the blocker's posts, as anyone does.
- **A hashtag feed isn't filtered** ([`GET /feed`](#get-feed)). A client that hides a blocked user's posts there does it by `publisher.userId`, with the list `GET /users/:userId/blocked` gives.
- **Nor is a [search](#search),** of users or of posts: it takes no credentials.

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
  ads: [ ad, ... ],                 // only where the instance shows ads in feeds
  tags: { "<tag>": [ record, ... ] } }
```

- `window` is the span of time the feed is of: `hours` back from when its first page was asked for.
- `count` is the number of records in the page, and `truncated` whether the window holds more: `nextCursor` then gets the next page.
- `tags` holds each hashtag's records, in the feed's order: most liked first in a `popular` feed, newest first in a `chronological` one. A hashtag with no record in the page is left out. To show a `popular` page as one list, take a record from each hashtag's list in turn; to show a `chronological` one, merge the lists by `createdAt`.
- `ads` holds the page's [ads](#ads), each `{ adId, label, kind, imageUrl?, imageAlt?, text?, url?, position }`. Show an ad before the page's `position`th post (3, 10 or 17, counted from 1), with its `label` ("Sponsored"). `kind` is `text` or `image`, `imageUrl` an image ad's [image](#get-monetizationadsadidimage), `imageAlt` that image's [alt text](#alt-text) where the ad has one, and `url` the [link](#get-monetizationadsadidclick) to follow. Ads aren't counted in `count`.

Each record is `{ contentId, publisher: { userId, username }, mimeType, aiGenerated, comments, preview, tags, likes, moderated, createdAt, updatedAt }`:
- `aiGenerated` is the publisher's declaration of whether the content was created with AI.
- `comments` is whether the post takes [comments](#comments). A record doesn't say how many it has: [`GET /content/:contentId/comments`](#reading-comments) does.
- `moderated` is whether a moderator of the hashtag the record is listed under has [approved](#a-hashtags-queue) it there. It's per hashtag, so the same post can be `true` under one and `false` under another.
- `preview` follows the post's type, as [previews](#previews) lists.
- `mentions` is there on a record whose `preview.text` [mentions](#mentions) users: `[{ userId, username }]`, the ones that part of the text names. The preview is cut so that a mention is in it whole or not at all.
- `publisher` is the user's current credit, so a renamed user shows under their new name everywhere at once. A feed's credit doesn't have the user's [avatar](#the-avatar): `GET /users/<userId>/avatar` is where it's read.
- `repost` and `origin` are there only on the records they apply to: `repost` on a record that is there because of a [repost](#post-repost), and `origin` on a repost of a [post on another server](#a-post-on-another-server).

**Pagination:** the cursor says where the feed has got to: the last record it returned under each hashtag, with the end of the window, the algorithm, the related hashtags the first page added, the `aiGenerated` and `moderated` filters and the fresh-content seed. The next page reads the hashtags' indexes as they are by then, and carries on after those records. So:
- Every page is of the first page's window. Posts newer than the first page show when the reader starts over.
- A post isn't returned twice, and what was deleted, held or taken out of a hashtag since the page before is left out, without anything else shifting. There are three exceptions, which a client that shows one list can settle by dropping a `contentId` it already has: a post returned in a fresh slot and liked afterwards, a post returned in a `popular` feed that then lost likes ([`DELETE /like`](#delete-like)) and so moved back in the order, and, in a `popular` feed of several hashtags, a post that lost the hashtag it was returned under and still carries another.
- What the compactor has applied since the page before shows: new like counts, and what moderators approved or removed.
- A session can miss a post that came to be ahead of where it had got to: one liked past that point between two pages of a `popular` feed, or one that reached the index late. It's there when the reader starts over.
- Later pages must ask for the same `tags`, `hours`, `algorithm`, `addRelated`, `aiGenerated` and `moderated`, otherwise `400`.
- A cursor doesn't expire. One issued by an earlier release of the server gets `410`, and the client should start over; one that isn't valid gets `400`.

**Limits:** a feed needs no key, so it's limited by the address it's asked from, and by how many feeds the instance is answering:
- **One address can ask for 120 feeds a minute** (`FEED_RATE_LIMIT_PER_MINUTE`), whatever feeds they are, later pages included. One past that gets `429`, with when to try again in a `Retry-After` header. Every response says where the address stands, in the headers `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds until the count starts again). An IPv6 address is counted with the rest of its /64.
- **An instance answers 100 feeds at a time** (`FEED_MAX_CONCURRENT`; each of its servers does, where it has several). One more gets `503` at once, rather than waiting behind them, with when to try again in a `Retry-After` header and in the body:
  ```json
  { "error": "the server is answering as many feeds as it can at once; try again in 1 second", "retryAfterSeconds": 1 }
  ```
  It says the instance is busy, not that the reader asked too often: the same request a second later is answered if a place is free.

#### Limits on reads that need no key

The other reads that anyone can make without a key are limited by address as feeds are, each on a count of its own, so using one up leaves the others:

| Request | A minute, from one address | Setting |
| --- | --- | --- |
| [`GET /feed`](#get-feed) | 120 | `FEED_RATE_LIMIT_PER_MINUTE` |
| [`GET /feed/following`](#get-feedfollowing) | 60 | `FEED_FOLLOWING_RATE_LIMIT_PER_MINUTE` |
| [`GET /content/:contentId`](#get-contentcontentid) | 300 | `CONTENT_RATE_LIMIT_PER_MINUTE` |
| [`GET /users/:userId/posts`](#get-usersuseridposts) | 120 | `PROFILE_POSTS_RATE_LIMIT_PER_MINUTE` |
| [`GET /users/:userId/avatar`](#the-avatar) | 300 | `AVATAR_RATE_LIMIT_PER_MINUTE` |
| [`GET /content/:contentId/comments`](#reading-comments) | 120 | `COMMENTS_LIST_RATE_LIMIT_PER_MINUTE` |
| [`GET /content/:contentId/comments/:commentId/replies`](#reading-comments) | 120 | `COMMENTS_LIST_RATE_LIMIT_PER_MINUTE` |
| [`GET /content/:contentId/attestation`](#attestations) | 60 | `REPOSTS_ATTESTATION_RATE_LIMIT_PER_MINUTE` |
| [`GET /search`](#search) | 60 | `SEARCH_RATE_LIMIT_PER_MINUTE` |

One past its limit gets `429`, with when to try again in a `Retry-After` header, and every response has the `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` headers. An IPv6 address is counted with the rest of its /64. A request with a key is counted the same: it's the address that's counted, not the user. `0` turns a limit off.

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
- A new post after the compactor's next run, as on `/feed`. An updated post shows as it now is after that run too, in its original place.
- Deletions and like counts after the next compactor run, as on `/feed`.
- Nothing of a user its reader [blocks](#blocks), where the request says who reads: with the reader's own credentials in the headers, a post a blocked user published is left out, and so is one a blocked user reposted. Since a block ends the follow, that's a blocked user's post that someone the reader follows reposted. A page can then have fewer records than `limit` with more to come: `truncated` and `nextCursor` say whether there are.

**Pagination:** the cursor names the last post the page returned, and the next page starts just after it. So pages never repeat a post, or skip one that was there when the previous page was read, even while new posts arrive and the compactor runs. Posts newer than the first page show when the reader starts over. A cursor doesn't expire. One that isn't valid, including a cursor from `/feed`, gets `400`.

**Limit:** one address can ask for 60 pages a minute (`FEED_FOLLOWING_RATE_LIMIT_PER_MINUTE`), counted apart from `/feed`, then gets `429` ([above](#limits-on-reads-that-need-no-key)).

### `GET /tags`

Lists the hashtags posts have used, most recently active first: `{ tags: [{ tag, lastActiveAt }] }`. `prefix` (letters, digits and `_`, with or without `#`) keeps those that start with it, and `limit` sets how many (200 by default, at most 1,000). The hashtags a post can have are another matter: [`GET /tagging`](#get-tagging) says those.

```bash
curl "localhost:3000/tags?prefix=mum"
```

## Search

`GET /search` finds users by the start of their username, or posts by the words of their text and by their hashtags. `type` says which of the two. It needs no key, and finds only what anyone can read.

```bash
curl "localhost:3000/search?type=users&q=jos"
curl "localhost:3000/search?type=content&q=mumbai+flooding"
curl "localhost:3000/search?type=content&q=%23news+road&limit=10"
```

It takes:
- `type`: `users` or `content`. Required.
- `q`: what to search for, from 1 to 200 characters, not counting the spaces at its ends. Required.
- `limit`: the most users or posts in the page, from 1 to 50. Left out, 20.
- `cursor`: optional, taken from the previous page's `nextCursor`.

Whatever is compared is put in lowercase first, and its accents are taken off, in `q` and in what it's compared with: `jos` finds José, and `CAFE` finds a post that says "café". What comes back is as it was written.

### Searching users

`type=users` returns the users whose username starts with `q`: `{ users: [{ userId, username }], nextCursor }`.

```json
{ "users": [
    { "userId": "6f1c…", "username": "José" },
    { "userId": "b20e…", "username": "Josephine" }
  ], "nextCursor": null }
```

- **It's the start of the name that's matched,** not a part of it: `lice` doesn't find Alice. Each character of `q` stands for itself, a space inside it too, and none is a wildcard.
- **Users come in the order of their names** as they're compared, and those whose names compare the same (José and jose) in the order of their ids.
- **A user who changes their name** is found by the new one at once, and no more by the old.
- **A user whose account is [deleted](#delete-usersuserid) isn't found,** from the moment it's deleted. A [banned](#bans) user still has their account, and is.
- **A `q` with nothing in it to compare,** such as an accent on its own, gets `400`.

### Searching posts

`type=content` returns the posts that have every word of `q`, newest first, by when they were created: `{ results: [record, ...], nextCursor }`. Each record is shaped as in [`/feed`](#get-feed), with two differences:

- **It has no `moderated` and no `repost`.** The first is per hashtag, and a search lists a post under none. A post is found once, as itself and at its own time, however often it was reposted.
- **Its `likes` are all the post has now.** A feed's are as of the compactor's last run.

What a post is found by:

- **The words of its text,** or of its caption if it's an image, a video or audio, read as its readers read it: without the characters that [format](TEXT_EDITORS.md#the-format) it.
- **Its hashtags,** every one. These are the hashtags the post has (`tags`), as they are now: one a [repost](#post-repost) gave it finds it, and one a moderator took off it doesn't. A `#word` that's written in the text and isn't among the post's `tags` finds nothing.
- **Not the whole of a long text.** A post keeps its 100 most frequent words (`SEARCH_MAX_KEYWORDS`), and of two as frequent the one that comes first. Common English words that say nothing of a post ("the", "and", "is") aren't kept, nor a single ASCII letter or digit, nor a word longer than 64 characters.
- **Nothing else.** Not its comments, the alt text of its images, a link post's address, or its publisher's name. A link post has no text, so it's found by its hashtags. The instance's entry for a [post on another server](#a-post-on-another-server) is found by the start of the original's text, which is all of it the instance holds, and by its hashtags.

How `q` is read:

- **As a post's text is, into words,** and a post must have them all, in any order. There's no search for a phrase.
- **Whole words only.** `flood` doesn't find "flooding", and a misspelt word finds what's misspelt the same way. A word with an apostrophe counts as the words on each side of it, so `mumbai` finds "Mumbai's".
- **A word that starts with `#` is read as a hashtag is:** `#Central-Mumbai` looks for `centralmumbai`. A hashtag and a word are otherwise the same thing to look for, so `news` and `#news` find the same posts: those with the hashtag, and those whose text has the word.
- **The common words are left out of `q` too,** so `the road to mumbai` is `road mumbai`. A `q` of nothing but such words is looked for as it is, and finds the posts that have them as hashtags.
- **At most 8 words are looked for.** The ones after them are ignored.
- **A `q` with no word in it,** such as `!!!` or a `#` alone, gets `400`.

What it finds, and when:

- **Only posts anyone can read.** Not one that's set for deletion or held in the [moderation queue](#the-moderation-queue), an entry whose original is [gone from its own server](#refreshing-a-repost), or a post of an account that's deleted. Those stop being found at once.
- **A new post is found once it's in feeds:** after the compactor's next run, which is seconds. The same goes for what an update changed, for a hashtag a repost added, and for one a moderator removed: until that run the post is found by what it was.
- **A post from before the instance had search** is found once its operator has indexed the posts that were there ([DEPLOY.md](DEPLOY.md#upgrading-to-search)).
- **[Blocks](#blocks) leave nothing out.** A search takes no credentials, so it's the same for everyone.

**Pagination:** the cursor names the last user or post of the page, and the next page starts just after it, so pages don't repeat one. A cursor doesn't expire. One that isn't valid gets `400`, and so does a cursor of one `type` sent with the other.

**Limit:** one address can make 60 searches a minute (`SEARCH_RATE_LIMIT_PER_MINUTE`), of either kind and later pages included, counted apart from the feeds, then gets `429` ([above](#limits-on-reads-that-need-no-key)).

| Status | What happened |
| --- | --- |
| `200` | A page of users, or of posts. It can be empty. |
| `400` | `type` isn't `users` or `content`, `q` is missing, longer than 200 characters or has nothing to search for, `limit` isn't from 1 to 50, or the `cursor` isn't one of this kind of search. |
| `429` | The address made its searches for the minute. `Retry-After` says when to try again. |

## Ads

An instance can show ads, which its admins keep: in hashtag feeds (`MONETIZATION_FEED_ADS`) and at the end of a post (`MONETIZATION_POST_ADS`), both off by default ([CONFIG.md](CONFIG.md#monetization)). Where they're on, a page of [`GET /feed`](#get-feed) comes with `ads`, and [`GET /content/:contentId`](#get-contentcontentid) with `ad`. An ad that leads somewhere has a `url`, and that `url` is the endpoint below, not the link its admin gave it.

### `GET /monetization/ads/:adId/click`

An ad's link. It counts a click on the ad, then redirects to where the ad leads. A client doesn't build it: it sends a reader who follows an ad to the ad's `url`, which is this.

```bash
curl -i "localhost:3000/monetization/ads/$AD_ID/click"
```

- It needs no key, and answers `302`, with the link the ad's admin gave it in `Location`. It goes there and nowhere a request names.
- It comes with `Cache-Control: no-store`, so a browser asks again each time the ad is followed.
- `url` is absolute where the instance sets `PUBLIC_BASE_URL`. Otherwise it's a path, to resolve against the instance's address.
- Every request is a click: nothing tells one reader from another, so following an ad twice counts twice. A `HEAD` request is redirected and not counted. Showing an ad counts nothing.
- A link an admin changes is the one followed from then on, and the ad's `url` stays the same. An ad that has ended still redirects, for a reader with a page from before.
- An ad that isn't there gets `404`, and so does one with no link.

The ad's admins read the count as `clicks`, with the ad ([below](#keeping-the-ads)).

### `GET /monetization/ads/:adId/image`

An image ad's image. It's what the ad's `imageUrl` is wherever the ad is shown, and it needs no key.

```bash
curl -o ad.png "localhost:3000/monetization/ads/$AD_ID/image"
```

- It returns the image's bytes, with their content type, as [`GET /content/:contentId/raw`](#get-contentcontentid) returns a post's: a redirect to a presigned URL on the stores that support one, and otherwise streamed, with `X-Content-Type-Options: nosniff` and the `Content-Security-Policy` that sandboxes them.
- `imageUrl` is absolute where the instance sets `PUBLIC_BASE_URL`. Otherwise it's a path, to resolve against the instance's address.
- It gives the image of any image ad the instance holds, whatever the ad's schedule.
- The address stays the same when an admin replaces the image, so a cache or CDN in front decides how long a copy is good for.
- A text ad has no image, and gets `404`, as does an ad that isn't there. A deleted ad's image is gone at once, though the ad is shown until the compactor's next run.

### Keeping the ads

Admins create, change and delete the ads. These authenticate as the other write endpoints do, the two `GET`s with the headers; anyone else gets `403`. They work whether or not the instance shows ads, so ads can be set up before either setting is on.

```bash
curl -X POST localhost:3000/monetization/ads -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -H "Content-Type: application/json" -d '{ "kind": "text", "text": "Fresh coffee, two streets away", "url": "https://coffee.example/", "tags": ["mumbai"] }'
curl -X POST localhost:3000/monetization/ads -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" \
  -F kind=image -F text="Shoes that last" -F url=https://shoes.example/ -F endsAt=2026-12-31T00:00:00Z -F content=@ad.png
```

| Endpoint | What it does |
| --- | --- |
| `POST /monetization/ads` | Creates an ad from the fields below: `201` with the ad. JSON, or `multipart/form-data` with the image in a part named `content`. An instance that already holds 100 ads that haven't ended gets `409`. |
| `GET /monetization/ads` | The ads, newest first, whatever their schedule: `{ ads: [ad, ...], nextCursor }`. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `GET /monetization/ads/:adId` | One ad. |
| `PATCH /monetization/ads/:adId` | Changes what the request names, and nothing else of the ad, and returns the ad. JSON or multipart, as `POST`. With nothing to change, `400`. |
| `DELETE /monetization/ads/:adId` | Deletes the ad, and its image: `{ adId, status: "deleted" }`. |

The fields of `POST` and `PATCH`:

| field | notes |
| --- | --- |
| `kind` | `text` or `image`. Required to create an ad, and an ad keeps it: a `PATCH` that names another gets `400`. |
| `text` | A text ad's text (required), or an image ad's caption (optional). At most 500 characters, trimmed of leading and trailing whitespace. |
| `url` | Optional. Where the ad leads: `http` or `https`, at most 2,048 characters. Readers aren't sent it: they get the [link that counts the click](#get-monetizationadsadidclick), which redirects here. |
| `tags` | Optional. The hashtags the ad is targeted at, at most 10: a list, or one string separated by commas or spaces, normalised as a post's are. The ad is then shown in a feed that reads one of them, and at the end of a post that carries one. With none, it's shown under every hashtag. |
| `startsAt` | Optional. When the ad starts being shown: ISO-8601 with its offset from UTC (`2026-12-01T00:00:00Z`, or `…+05:30`); one without an offset gets `400`. Left out of a new ad: now. |
| `endsAt` | Optional. When it stops, in the same form. It must be after `startsAt` (`400`). With none, the ad has no end. |
| `content` | An image ad's image: a file part (multipart), or a string in JSON with `contentEncoding: "base64"` (a JSON request can be at most 16 MB). Required to create an image ad, and a `PATCH` that sends one replaces the image. A JPEG, PNG, GIF or WebP, told by its bytes and stored [without its metadata](#images), as an image post's is; any other file gets `400`. At most 10 MiB, or `MAX_UPLOAD_BYTES` if that's less (`413`). A text ad has none (`400`). |
| `alt` | Optional. An image ad's [alt text](#alt-text): what its image shows, for people who can't see it. At most 1,500 characters. A text ad has none (`400`). A `PATCH` that replaces the image keeps the alt text the ad had unless it gives another, so send one with a new image. |

A `PATCH` clears `url`, `tags`, `endsAt`, an image ad's caption or its `alt` when it gives the field as `null`, or as an empty string, which is all a form field can send. A field it leaves out stays as it is.

An ad is `{ adId, kind, imageUrl, imageAlt, text, url, tags, startsAt, endsAt, status, clicks, createdBy, createdAt, updatedAt }`:

| field | notes |
| --- | --- |
| `imageUrl` | An image ad's [image](#get-monetizationadsadidimage). A text ad has none. |
| `imageAlt` | An image ad's alt text. Left out where the ad has none. |
| `text`, `url` | The ad's text or caption, and where it leads: the link its admin gave, not the one its readers get. Each is left out where the ad has none. |
| `tags` | The hashtags the ad is targeted at, or `null` for one shown under every hashtag. |
| `startsAt`, `endsAt` | The ad's schedule. `endsAt` is `null` for an ad with no end. |
| `status` | Where the schedule has the ad now: `scheduled` (yet to start), `live` (being shown, where the instance shows ads) or `ended`. |
| `clicks` | How many times the ad's [link](#get-monetizationadsadidclick) was followed. It only goes up, and no request sets it: it's kept when the ad's `url` or anything else of it is changed, or its `url` is cleared. |
| `createdBy` | The `userId` of the admin who created the ad, or `null` once that account is gone. |
| `createdAt`, `updatedAt` | When the ad was created, and when it was last changed. A click doesn't change `updatedAt`. |

What else to know:
- **Changes show after the compactor's next run.** Feeds and posts show the ads as the [compactor](APP.md#8-the-compactor) last published them, so an ad that was created, changed or deleted shows as it now is `COMPACT_INTERVAL_SECONDS` later at most (5 by default), plus the time the run takes. A schedule needs no run: an ad starts and ends on time. The link an ad leads to is the exception, and changes at once.
- **At most 100 ads that haven't ended,** counting the ones yet to start. One more gets `409`, and so does a `PATCH` that brings an ended ad back. Ended ads take no room, and are kept until an admin deletes them.
- **An ad can be created already over,** with both `startsAt` and `endsAt` in the past: it's kept, and never shown.
- An ad that isn't there gets `404`, and an `adId` that isn't an id gets `400`.

## Rules

### `GET /rules`

Gives the server's rules, the email address to write to for support, and its modification disclosure. It needs no key, so a client can show all three to someone before they register.

```bash
curl localhost:3000/rules
```

```json
{
  "modificationDisclosure": { "modified": true, "release": "0.1.0", "sourceUrl": "https://git.example.com/our-evieverse" },
  "supportEmail": "support@example.com",
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
| `supportEmail` | The email address to write to for support, which the server's operator sets (`SUPPORT_EMAIL`). It's always there: a server whose operator set none gives `noreply@yoururl.com`, a placeholder that nobody reads. The server sends it nothing, and no request changes it. |
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

### A hashtag's rules

A hashtag has rules of its own: what its moderators ask of the posts under it. `GET /tags/:tag/rules` gives them, to anyone, with a key or without. `:tag` is a hashtag as `/feed` takes it, with or without a `#` (sent as `%23`).

```bash
curl localhost:3000/tags/cars/rules
```

```json
{
  "tag": "cars",
  "rules": [
    { "ruleId": "9a4e7c10-…", "position": 1, "text": "Cars only: no trucks.", "createdAt": "2026-11-18T09:00:00.000Z", "updatedAt": "2026-11-18T09:00:00.000Z" }
  ]
}
```

Each rule is as `GET /rules` gives one, and the list works the same way: the whole list in its order, at most 100 rules for a hashtag, each of at most 2,000 characters. A hashtag whose moderators set none has `[]`, whether or not any post uses it. The server's own rules aren't in it, and a hashtag's aren't in `GET /rules`.

The hashtag's moderators keep them, and so can server moderators and admins, on every hashtag. Anyone else gets `403`.

| Endpoint | What it does |
| --- | --- |
| `POST /tags/:tag/rules` | `{ "text": "...", "position": 2 }` adds a rule, as `POST /rules` does: `201` with `{ tag, ruleId, position, text, createdAt, updatedAt }`. A hashtag that already has 100 rules gets `409`. |
| `PATCH /tags/:tag/rules/:ruleId` | `{ "text": "...", "position": 1 }`, either or both, as `PATCH /rules/:ruleId`: returns the rule, with its `tag`. |
| `DELETE /tags/:tag/rules/:ruleId` | Removes the rule: `{ tag, ruleId, wasThere }`. The rules after it move up by one. |

A rule that isn't one of this hashtag's gets `404` from `PATCH` and `wasThere: false` from `DELETE`, though it be another hashtag's. What gets `400` is as for the server's rules.

As with the server's rules, no post is checked against them: they're what a moderator goes by when [approving a post or removing the hashtag from it](#a-hashtags-queue), and what the `reason` of a removal can point to.

## Moderation

The server's admins, its server moderators and each hashtag's moderators decide what's published, and under which hashtags. Their rules are checked when a post or an update is written, and what they decide about a post is written into the feed index, so feeds never consult the database for any of it and it costs readers nothing.

There are three queues to decide on. The first two hold [comments](#comments) as well as posts, in one list:
- [The moderation queue](#the-moderation-queue) holds the posts, under any hashtag, and the comments that the server didn't trust enough to publish. They aren't published until a server moderator or an admin accepts them.
- [The report queue](#the-report-queue) holds the published posts and comments that users reported, until a server moderator or an admin accepts or deletes them. They stay published while they wait.
- [Each hashtag's queue](#a-hashtags-queue) is every post published under the hashtag that none of its moderators has decided on yet. Those posts are published all along. Comments aren't in it.

**Admins** can delete any content (`DELETE /content/:contentId`) and any comment, accept or reject the posts and comments in the moderation queue, appoint and remove server moderators and tag moderators, keep the server's list of blocked words, and make other users admins or revoke the role. They can also do whatever a server moderator can, and whatever a tag moderator can on every hashtag, and they [register users](#post-register) without a challenge.

**Server moderators** are appointed by an admin (`PUT /moderators/:userId`) to work through [the moderation queue](#the-moderation-queue) and [the report queue](#the-report-queue), so that doesn't take an admin. They can read the moderation queue and the posts and comments waiting in it, and accept or reject each; and read the report queue and the reports of each post or comment in it, and accept or delete each. They can also do whatever a tag moderator can, on every hashtag, without being appointed to any. That's all the role gives:
- They can't delete published content or a published comment that nobody has reported, or anyone else's outside the two queues.
- They can't keep the server's blocked words, or appoint anyone, a hashtag's moderators included. They can refuse a [claim to a hashtag](#claiming-a-hashtag), as an admin can.

Admins and moderators can do all of it with the [CLI](CLI.md) the server ships, which signs in with their own API key.

**The first admin** comes from whoever runs the server, since making an admin over the API takes one. The [Terraform modules](DEPLOY.md#the-admin-account) create an admin account with every deployment, and anywhere else the operator makes one from the command line ([APP.md](APP.md#moderation)). From then on, admins make more over the API (`PUT /admins/:userId`), and the API never leaves the server without one: revoking the only admin gets `409`.

**Tag moderators** moderate one or more hashtags: an admin or one of the hashtag's moderators appointed them to it, or they [claimed it](#claiming-a-hashtag) when it had none ([below](#a-hashtags-moderators)). For each of those, they can:
- keep the hashtag's list of blocked words;
- mute users on the hashtag, so that the user's new posts and updates don't get it;
- work through [the hashtag's queue](#a-hashtags-queue): approve the content under it, or remove the hashtag from content;
- set the hashtag's [rules](#a-hashtags-rules);
- appoint other moderators of the hashtag, and remove the ones who became one after them.

Server moderators and admins can do all of that but the last on every hashtag, without being appointed to it. The last is an admin's on every hashtag, and not a server moderator's.

A tag moderator has no say over comments. A hashtag's blocked words and mutes apply to posts alone, and a comment on a post under the hashtag isn't its moderators' to accept, reject or delete.

A user's profile (`GET /users/:userId`) shows whether they're an `admin` or a server moderator (`moderator`), and the hashtags they moderate (`moderates`). `moderates` lists the hashtags a user was appointed to or claimed, so it's empty for an admin or a server moderator who has neither, though they moderate every hashtag.

**Server moderators and admins can [ban](#bans) a user**, and admins can delete any [account](#delete-usersuserid).

### A hashtag's moderators

`GET /tags/:tag/moderators` lists a hashtag's moderators, to anyone, in the order they became one: `{ tag, moderators: [{ userId, username, since }] }`, and `claim` too while a [claim to the hashtag](#claiming-a-hashtag) waits.

**Appointing.** `PUT /tags/:tag/moderators/:userId` makes a user a moderator of the hashtag. An admin can, and so can any of the hashtag's own moderators. Whoever is appointed moderates the hashtag as the others do, and can appoint in turn.

**Removing.** `DELETE /tags/:tag/moderators/:userId` ends a user's time as a moderator of the hashtag.
- An admin can remove any of them.
- One of the hashtag's moderators can remove those who became a moderator after them (a later `since`), whoever appointed them, and themselves. Removing one who was there before them, or since the same moment, gets `403`. So a moderator can't be turned out by someone they brought in, and whoever was the hashtag's first moderator stays until they leave or an admin removes them.
- A moderator who is removed and appointed again is there since the second time.

Anyone else gets `403` from both, a server moderator included, unless they're also one of the hashtag's moderators.

The user is told, by a [notice](#notices): `tag_moderator_added` when they're made a moderator, and `tag_moderator_removed` when they're one no more. Neither says who did it. There's none for a request that changed nothing, or for a moderator who left of their own accord.

A hashtag whose last moderator left or was removed has none, and can be claimed again.

### Claiming a hashtag

Where publishers choose their posts' hashtags (`TAGGING_MODE=user`), hashtags come to be as posts use them, and nobody was there to appoint a moderator for each. So a user can claim a hashtag that has no moderator. A claim isn't granted at once: it waits 24 hours (`TAG_CLAIM_REVIEW_HOURS`), the server's admins and server moderators are told, and any of them can refuse it. A claim nobody refused is granted when the wait is over, by the compactor's next run: the user is a moderator of the hashtag from then on, its first, like one an admin appointed.

`POST /tags/:tag/claim` claims the hashtag for the caller. The hashtag needn't have a post yet.

```bash
curl -X POST localhost:3000/tags/cars/claim -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID"
```

```json
{ "tag": "cars", "userId": "...", "username": "alice",
  "claimedAt": "2026-11-18T09:00:00.000Z", "reviewUntil": "2026-11-19T09:00:00.000Z",
  "alreadyClaimed": false }
```

It answers `201`, or `200` with `alreadyClaimed: true` if the caller's claim to the hashtag already waits, which changes nothing. `reviewUntil` is until when the claim can be refused, and after which it's granted. It's refused with:

| Status | When |
| --- | --- |
| `403` | The caller is [banned](#bans). |
| `400` | The server chooses its hashtags itself (`TAGGING_MODE=server`): an admin appoints their moderators. |
| `409` | The caller is an admin or a server moderator, who moderate every hashtag already. |
| `409` | The hashtag has a moderator. Only a hashtag with none can be claimed: its moderators, or an admin, appoint the others. |
| `409` | Another user's claim to the hashtag waits. A hashtag has one claim at a time. |
| `429` | The caller already made 5 claims in a day (`TAG_CLAIMS_PER_DAY`). The response says when to try again, in a `Retry-After` header and as `retryAfterSeconds`. A claim that was refused for another reason doesn't count, and nor does claiming a hashtag again. |

**Every admin and server moderator gets a notice** (`tag_claimed`) that says who claimed which hashtag and until when the claim can be refused, with `details: { userId, username, reviewUntil }`. `GET /moderation/tag-claims` lists the claims that wait, for them, and `GET /tags/:tag/moderators` shows a hashtag's, to anyone, as `claim`: `{ tag, userId, username, claimedAt, reviewUntil }`.

`DELETE /tags/:tag/claim` ends the claim that waits, and returns `{ tag, wasClaimed, userId, refused }`:
- From an admin or a server moderator, it refuses the claim (`refused: true`), and the claim's user gets the notice `tag_claim_refused`.
- From the claim's own user, it withdraws it (`refused: false`). Nobody is told.
- From anyone else, `403`.
- Where no claim waits, `{ tag, wasClaimed: false, refused: false }`.

What ends a claim otherwise:
- **It's granted.** The user gets the notice `tag_claim_granted`. With `TAG_CLAIM_REVIEW_HOURS=0` that's the compactor's next run, seconds later, so the admins and server moderators learn of the claim as it's granted, and an admin can only undo it (`DELETE /tags/:tag/moderators/:userId`).
- **The hashtag is given a moderator meanwhile.** Appointing anyone to the hashtag ends the claim to it. If it's the claim's own user who was appointed, they have what they asked for; otherwise the claim's user is told it was refused.
- **The user is banned when the wait is over.** The claim isn't granted, and they're told it was refused.
- **The user's account is closed.** The claim goes with it.

A claim made before a server was set to `TAGGING_MODE=server` is still granted, unless it's refused.

### Bans

A server moderator or an admin bans an account with `PUT /banned/:userId`, and ends the ban with `DELETE /banned/:userId`. A banned user keeps their account, their key and their posts, and can still read everything, but is refused (`403`, "your account is banned") by whatever writes a post, a comment, a like or a message:
- `POST /store`, for a new post and for an update of one of their own;
- `POST /content/:contentId/comments`, and `PATCH /content/:contentId/comments/:commentId` for an edit of one of their own;
- `POST /like`, of a post or of a comment. The likes they made before the ban stay, and are still theirs to take back (`DELETE /like`);
- `POST /messages`;
- `POST /uploads`, since a link is for posting the file;
- `PATCH /users/:userId` with a `bio` or `links`, and `PUT /users/:userId/avatar`: a banned user puts nothing on their [profile](#a-users-profile). The `403` says so: "your account is banned: you can take your bio, your links and your avatar away, and can't set them".

That is all a ban stops. A banned user can still read their inbox, receive messages, delete their own posts and comments, take back their likes, change their settings and key, take their bio, links and avatar away, pin and unpin posts, report posts, follow users, and [delete their account](#delete-usersuserid). A ban doesn't take down what was posted before it: a moderator deletes that as they would any content.

**A ban hides the user's profile.** While it lasts, nobody is shown what the user put on it:
- [`GET /users/:userId`](#get-usersuserid-and-patch-usersuserid) says `banned: true`, and gives no bio, no links, no avatar and no pinned post. The name, the roles and `createdAt` are as before;
- [`GET /users/:userId/avatar`](#the-avatar) is `404` ("this user is banned, so their avatar isn't shown"), and the user's credit on a post has no `avatarUrl`. A copy of the avatar that a reader or a cache got before the ban can last up to a day more;
- [`GET /users/:userId/posts`](#get-usersuseridposts) says `banned: true`, and lists no post.

Nothing of it is deleted: it's all shown again when the ban ends. The posts themselves stay in feeds and in searches, and are read by their ids.

- A ban is of one account: an admin or a server moderator can't be banned (`403`) until their role has ended, and nobody can ban themselves (`400`).
- The user gets a [notice](#notices), once: `user_banned`, and `user_unbanned` when the ban ends. A ban has an optional `reason` (at most 500 characters), which only server moderators and admins can read.
- Banning a user who is banned changes nothing, and returns `200` with `alreadyBanned: true` and the first ban's time and reason. Ending a ban that isn't there returns `wasBanned: false`.
- A user's own [`GET /whoami`](#get-whoami) says whether they're `banned`, and so does their public profile. Why, and by whom, is in neither.
- A ban doesn't remove a role: appointing a banned user as a moderator is allowed, but they can't then be banned again until the role ends.
- The ban is a column of the account, so it takes effect with the next request, and doesn't change feeds.

**The user is told.** When a moderator or an admin removes a hashtag from a post, accepts or rejects it in the moderation queue, or deletes it, its publisher gets a [notice](#notices) in their [inbox](#inbox). So does a user who is muted on a hashtag, or whose mute ends, and the author of a comment that is accepted or rejected in the moderation queue, or that someone else deletes.

**What happens to a post.** Every new post and update is checked before the [limit on posts a minute](#limits-on-posts-and-comments). A refused post isn't a post: nothing is stored, and it doesn't count towards the limit.
1. The post gets a **trust score**, from 0 (not trusted at all) to 100. It starts at 100 and goes through each of the [trust plugins](TRUST_PLUGINS.md) the server runs, which can only lower it. The server comes with three:
   - `blocked_words`, which every server runs: a post containing a word or phrase on the server's list, or matching one of its patterns, scores 0.
   - `urlhaus`, which is optional and runs only on a server that turns it on (`TRUST_OPTIONAL_PLUGINS=urlhaus`): a post with a link on [URLhaus](https://urlhaus.abuse.ch)'s list of malware URLs scores 0. Every link counts: a link post's URL, and the links written in a text or a caption. The server never follows a link; it looks it up in its own copy of the list.
   - `pdq`, which is optional too (`TRUST_OPTIONAL_PLUGINS=pdq`): an image post with an image whose [PDQ](https://github.com/facebook/ThreatExchange/tree/main/pdq) hash is on the server's list of hashes of known child sexual abuse material scores 0, and the server's admins get a [notice](#an-image-that-matches-the-servers-list). Every image of an [album](#albums) counts, and each frame of an animated one, up to the 32nd. An image the server can't decode, and so can't check, scores one less than `TRUST_SCORE_ALLOW_FROM`.
2. The score says where the post goes, by two thresholds:

   | Score | Where the post goes |
   | --- | --- |
   | Less than `TRUST_SCORE_DELETE_BELOW` (25) | It's deleted on arrival: refused with `422`, and nothing of it is kept. |
   | From there up to `TRUST_SCORE_ALLOW_FROM` (75) | It's held in [the moderation queue](#the-moderation-queue) for a server moderator or an admin. |
   | `TRUST_SCORE_ALLOW_FROM` or more | It's published. |

   So with the defaults and no other plugin, a post with one of the server's blocked words is refused, and every other post is published. With `urlhaus` turned on, a post with a listed link is refused too. The `422` says which it was:

   ```json
   { "error": "the post has a link that is known to spread malware, so it wasn't published" }
   ```

   With `pdq` turned on, a post with an image that matches its list is refused as well, and the `422` doesn't say why: it has the general message, "this server doesn't trust the post enough to keep it, so it wasn't published". A post with an image the server can't decode is held in the queue (`202`). On a server whose two thresholds are the same, which has no queue, it's refused instead, with "an image of the post couldn't be read to check it, so it wasn't published". While a server that runs `pdq` has no list to check with, because it couldn't read one yet, a post with an image gets `500`.

   `TRUST_SCORE_DELETE_BELOW=0` holds posts with a blocked word in the queue instead of refusing them, and `TRUST_SCORE_ALLOW_FROM=101` holds every post. The score is used for this and nothing else, and is kept nowhere but beside a post in the moderation queue.
3. Each of its hashtags is dropped if its publisher is muted on that hashtag, if a moderator removed that hashtag from this content, or if the post contains a word or phrase on that hashtag's list, or matches one of its patterns.
4. A post with no hashtag left is refused with `422`, since a post can't go live without one. The response says why each hashtag was dropped:

   ```json
   { "error": "none of the post's hashtags is allowed on it, and a post needs one, so it wasn't published",
     "removedTags": [{ "tag": "news", "reason": "muted" }] }
   ```
5. Otherwise it's published, or held, with the hashtags left, and the response lists those dropped in `removedTags`. Each `reason` is `muted`, `removed` or `blocked_word`.

If what's left is exactly the content's hashtags, on a text or link post that's otherwise the same and going where the content already is, nothing is stored and the response is `unchanged: true` (with `removedTags`).

**What happens to a comment.** A [comment](#post-contentcontentidcomments) goes through steps 1 and 2 as a post does: the same plugins score it, and the same two thresholds refuse it (`422`), hold it in the moderation queue (`202`) or publish it (`201`). An [edit](#patch-contentcontentidcommentscommentid) of a comment is scored the same way, on its new text (`200` where a new comment gets `201`). A plugin is told that it's looking at a comment, and on which post ([TRUST_PLUGINS.md](TRUST_PLUGINS.md)), so its refusal can say so: with `urlhaus` turned on, a comment with a listed link gets "the comment has a link that is known to spread malware, so it wasn't published". With `pdq` turned on, the image a comment comes with is checked as a post's images are, when the comment is sent: an edit keeps the comment's file, which isn't checked again. Steps 3 to 5 are about hashtags, which a comment doesn't have: a hashtag's blocked words and mutes don't apply to it. It's checked before the [limit on comments a minute](#limits-on-posts-and-comments), so a refused comment doesn't count towards it.

**What happens to a profile.** A bio, links and an avatar go through step 1 as a post does, when the user sets them ([above](#a-users-profile)): the same plugins score them, each told that it's looking at a profile. There's no queue for a profile to wait in, so step 2 has two outcomes: a score of `TRUST_SCORE_ALLOW_FROM` or more saves it, and anything less refuses it (`422`), with nothing saved. A plugin's refusal says it's a profile:

| What was refused | The `422` says |
| --- | --- |
| A bio, a link or an avatar's filename with one of the server's blocked words | "it contains a word or phrase this server doesn't allow, so it wasn't saved" |
| With `urlhaus` turned on, a link, or a bio with a link, that's on its list | "it has a link that is known to spread malware, so it wasn't saved" |
| With `pdq` turned on, an avatar that matches its list | "this server doesn't trust this enough to show it on a profile, so it wasn't saved", which doesn't say why. The admins get the [notice](#an-image-that-matches-the-servers-list). |
| With `pdq` turned on, an avatar it can't decode | "the image couldn't be read to check it, so it wasn't saved" |

A server that deletes nothing on arrival (`TRUST_SCORE_DELETE_BELOW=0`) refuses these too: what it would hold of a post, it refuses of a profile. Steps 3 to 5 are about hashtags, which a profile doesn't have.

### The moderation queue

A post whose trust score is between the two thresholds is stored, but not published: `POST /store` answers `202` with `status: "pending_review"`, and the post is in no feed, not even its publisher's followers'. Only its publisher, server moderators and admins can read it ([`GET /content/:contentId`](#get-contentcontentid)), and nobody can like it.

Server moderators and admins read the queue with `GET /moderation/queue`, longest waiting first, and decide on each post:
- **Accept** (`POST /moderation/queue/:contentId/accept`) publishes it, under its hashtags and to its publisher's followers, as posted when it was sent: its `createdAt` doesn't change. It can be read at once, and is in feeds after the compactor's next run, like any post. It then waits in each of its hashtags' queues like any published post.
- **Reject** (`POST /moderation/queue/:contentId/reject`) takes it down, as `DELETE /content` does.

The publisher can update a held post, or delete it. Each update is scored again:
- One that's held too keeps the post's place in the queue.
- One that scores high enough to be published is published, with nobody's decision.
- An update of *published* content that's held takes the content out of every feed on the compactor's next run, until it's accepted, and makes it `404` by its id at once to everyone who can't read it in the queue. What the content was before isn't kept: content has one version.

**Comments wait in the same queue.** A [comment](#comments) whose trust score is between the thresholds is stored, but not published: `POST /content/:contentId/comments` answers `202` with `status: "pending_review"`, and the comment is neither in the post's list of comments nor in its count. Only its author, server moderators and admins can read it. `GET /moderation/queue` lists it among the posts, in the one order, and each item's `kind` says which it is: `"post"` or `"comment"`. They decide on it as on a post:
- **Accept** (`POST /moderation/queue/:contentId/comments/:commentId/accept`) publishes it, among the post's comments where it was sent, not where it was accepted: its `createdAt` doesn't change. Anyone can read it by its id at once, and it's in the post's [lists and counts](#reading-comments) after the compactor's next run. A reply is published under the comment it replies to, or under that comment's [placeholder](#placeholders) if it was deleted meanwhile. If nothing is left of that comment, not a placeholder, the reply has nowhere to go: it's deleted, and the request gets `404`, "the comment it replies to is gone, so this comment was deleted".
- **Reject** (`POST /moderation/queue/:contentId/comments/:commentId/reject`) deletes it, for good: that comment, and none of the replies it may have. It's gone by its id at once. Where an edit had left its placeholder in the lists, they change after the compactor's next run.

Its author is told of either with a [notice](#notices). The author can delete a comment that waits, which takes it out of the queue, or [edit](#patch-contentcontentidcommentscommentid) it. Each edit is scored again, as an update of a post is:
- One that's held too keeps the comment's place in the queue.
- One that scores high enough to be published is published, with nobody's decision.
- An edit of a *published* comment that's held takes the comment off the post, until it's accepted: by its id at once, and in the lists after the compactor's next run. It leaves a placeholder with `status: "pending_review"` in its place, which keeps its replies where they are. What the comment said before isn't kept. Accepted, it's published as edited, where it was, with the replies and likes it had. Rejected, it's deleted, and its placeholder says `deleted` if it has replies.

A comment that waits on a post that is deleted leaves the queue with the post.

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
- **Delete** (`POST /moderation/reports/:contentId/comments/:commentId/delete`) deletes it, for good, with its reports: it's gone by its id at once, and from the post's lists and counts after the compactor's next run. Its author gets a [notice](#notices), which doesn't mention the reports.

A comment that its author, the post's publisher or an admin deletes leaves the queue, and so do the comments of a post that is deleted. A post's reports and its comments' are decided on apart: accepting a post settles none of its comments' reports.

### A hashtag's queue

Every post is published under its hashtags unmoderated. Each record of a hashtag's feed says so: `moderated` is `false` until one of the hashtag's moderators approves the post there. So a hashtag's queue is its feed without the approved posts, and is read like any feed, by anyone:

```bash
curl "localhost:3000/feed?tags=news&moderated=false&hours=2160"
```

A feed is of its window, which is the past day unless it says. So a queue asks for the widest one, `hours=2160` (90 days), to get every post that waits and not only the last day's.

A moderator of the hashtag, a server moderator or an admin takes a post out of its queue in one of two ways:
- **Approve it** (`PUT /content/:contentId/tags/:tag`). Its records under that hashtag are `moderated: true` from then on. The approval is of the post as it was, so an update of the post puts it back in the queue.
- **Remove the hashtag from it** (`DELETE /content/:contentId/tags/:tag`). The post leaves the hashtag's feeds, and loses the hashtag for good: the publisher's updates don't get it back (`removedTags` gives the reason `removed`). The moderator can say why, with `{ "reason": "..." }`.

Each of the two is written down on the post, where [`GET /content/:contentId`](#get-contentcontentid) gives it to whoever reads the post, as `moderation`: which hashtag was removed or approved, as what the moderator did it (never who), when, and the reason a removal was given.

Both are recorded at once, and show in the hashtag's feeds after the compactor's next run, which applies them: it flags the post as moderated in the hashtag's index, or takes the hashtag off the post.

Moderation is per hashtag: a post under `#news` and `#mumbai` waits in both queues, and approving it under one leaves it in the other's. A feed of several hashtags with `moderated=false` returns the posts not approved under at least one of the hashtags asked for.

Later pages of a [feed session](#get-feed) are of the queue as it is by then: a post approved or removed since the page before, once the compactor has run, isn't on them.

### Blocked words

The server has a list of blocked words, which its admins keep, and so has each hashtag, kept by its moderators, and by server moderators and admins. A post containing one of the server's isn't published, and a post containing one of a hashtag's doesn't get that hashtag ([above](#moderation)).

**What's checked for blocked words:** the post's hashtags, its whole text (a text post's text, or an image's, video's or audio's caption), a link's URL, and a file's filename. A text or caption is read as its readers read it: without its [formatting](TEXT_EDITORS.md), so `sp**am**` is the word "spam", and with each link's address after its label, so a link is checked for where it leads too. A comment's text is read the same way. What's in an image, video or audio file isn't checked.

**How words match:** whole words and phrases, whatever their case or Latin accents. `spam` matches "Spam!" but not "spammers", `cafe` matches "Café", and `buy now` matches "Buy... NOW". A word is a run of letters and digits, so punctuation and spaces between a phrase's words don't matter. Entries are normalised the same way when they're added (`"  BUY  now!"` is stored as `buy now`). An entry has at most 8 words and 100 characters, and a list holds at most 10,000 entries.

**Patterns:** an entry written between slashes is a regular expression, and matches wherever it's found in a text, in the middle of a word too: `/scam\w*/` matches "scammers". That's the way to block a word of a script written without spaces between words, such as Chinese or Japanese. A whole run of such characters is one word, so a plain entry only matches all of it, where `/垃圾|广告/` matches "这是垃圾邮件".

- **Syntax:** JavaScript's, always with the `i` and `u` flags: whatever the case, and with `\p{…}` for Unicode properties. Nothing follows the closing slash, so `/spam/i` is refused. In JSON a backslash is written twice: `"/scam\\w*/"`.
- **Accents and full-width forms don't matter,** in the pattern or in the text: `/café/` matches "CAFE", and `/spam/` matches "ｓｐａｍ".
- **Each text is checked on its own,** so `^` and `$` are the start and the end of the post's text, the URL, the filename or one hashtag. `.` doesn't match a line break.
- **A pattern is stored as it was written,** slashes included. That's how it's listed, and how it's removed.
- **Limits:** a pattern has at most 100 characters, slashes included, and can't match empty text, which would match every post. A list holds at most 100 patterns among its entries.
- **Time:** a list's patterns get 100 ms to check a post. If they take longer, the post is treated as containing one of the list's blocked words, and the server's log names the pattern that ran out of time. Patterns that repeat a repetition, such as `(a+)+`, are the ones that do: write them another way.

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
| `GET`, `POST`, `DELETE /moderation/blocked-words` | Admins | Lists, adds or removes the server's blocked words. `POST` and `DELETE` take `{ "words": [...] }`, 1 to 1,000 words, phrases or patterns at a time. Each returns the whole list: `{ words }`. `400` for an entry that can't be blocked: one with no letters or digits, one that's too long, or a pattern that isn't a regular expression or matches empty text. `409` if the list would hold more than 10,000 entries, or more than 100 patterns. |
| `GET`, `POST`, `DELETE /tags/:tag/blocked-words` | The hashtag's moderators, server moderators, and admins | The same, for the hashtag's list: `{ tag, words }`. |
| `GET /tags/:tag/moderators` | Anyone | `{ tag, moderators: [{ userId, username, since }] }`, in the order they became one, with `claim: { tag, userId, username, claimedAt, reviewUntil }` while a [claim](#claiming-a-hashtag) to the hashtag waits. |
| `PUT /tags/:tag/moderators/:userId` | Admins, and the hashtag's moderators | [Appoints a moderator](#a-hashtags-moderators): `201` with `{ tag, userId, since, alreadyModerator: false }`, or `200` with `alreadyModerator: true` if they already were. Ends a claim to the hashtag that waits. |
| `DELETE /tags/:tag/moderators/:userId` | Admins, and the hashtag's moderators | `{ tag, userId, wasModerator }`. One of the hashtag's moderators can remove only those who became one after them, and themselves: `403` for any other. |
| `POST /tags/:tag/claim` | Any user, in `user` tagging mode | [Claims the hashtag](#claiming-a-hashtag): `201` with `{ tag, userId, username, claimedAt, reviewUntil, alreadyClaimed: false }`, or `200` with `alreadyClaimed: true`. |
| `DELETE /tags/:tag/claim` | The claim's user, server moderators, and admins | Withdraws the claim that waits, or refuses it: `{ tag, wasClaimed, userId, refused }`. |
| `GET /moderation/tag-claims` | Server moderators, and admins | The claims that wait, longest waiting first: `{ claims: [{ tag, userId, username, claimedAt, reviewUntil }], nextCursor }`. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `GET /tags/:tag/rules` | Anyone | The hashtag's [rules](#a-hashtags-rules): `{ tag, rules }`. |
| `POST /tags/:tag/rules`, `PATCH`, `DELETE /tags/:tag/rules/:ruleId` | The hashtag's moderators, server moderators, and admins | Adds, changes or removes one of the hashtag's rules. |
| `GET /tags/:tag/muted` | The hashtag's moderators, server moderators, and admins | Users muted on the hashtag, most recently muted first: `{ tag, muted: [{ userId, username, mutedAt }], nextCursor }`. Takes `limit` (100 by default, at most 1,000) and `cursor`. |
| `PUT /tags/:tag/muted/:userId` | The hashtag's moderators, server moderators, and admins | Mutes a user on the hashtag: `201` with `{ tag, userId, mutedAt, alreadyMuted: false }`, or `200` with `alreadyMuted: true`. |
| `DELETE /tags/:tag/muted/:userId` | The hashtag's moderators, server moderators, and admins | `{ tag, userId, wasMuted }` |
| `PUT /content/:contentId/tags/:tag` | The hashtag's moderators, server moderators, and admins | Approves the content under the hashtag: `201` with `{ contentId, tag, moderated: true, alreadyApproved: false }`, or `200` with `alreadyApproved: true`. |
| `DELETE /content/:contentId/tags/:tag` | The hashtag's moderators, server moderators, and admins | Removes the hashtag from the content (below). With `{ "mute": true }`, it also mutes the content's publisher on the hashtag. With `{ "reason": "..." }` (1 to 500 characters), it says why, on the post. |
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

Someone without the role gets `403`. A user or content that doesn't exist gets `404`, and so does accepting or rejecting content or a comment that isn't in the moderation queue, or accepting or deleting one that isn't in the report queue. Listing reports is different: a post or a comment that has none waiting gets `200` with an empty `reports`, and so does a comment that was deleted, or was never on the post. An entry with no letters or digits, or too long, gets `400`, and adding past 10,000 entries gets `409`.

**Removing a hashtag from content** is recorded at once. The compactor's next run then writes the content's meta file and summary again without the hashtag, and takes the content out of the hashtag's index, which is when that hashtag's feeds stop returning it, and `GET /content` and the content's records under its other hashtags stop listing the hashtag. Its bytes, text, preview and AI flag stay as they are. The response is `{ contentId, tag, tags, muted }`, with the hashtags the content is left with in `tags`.
- The removal is written down on the post, with the `reason` if the request gave one, and shows there at once, in the `moderation` of [`GET /content/:contentId`](#get-contentcontentid). A reason is public: whoever can read the post reads it. An empty one, or one over 500 characters, gets `400`.
- The removal is recorded, and stays: the publisher's updates of that content don't get the hashtag back. Their other content still can. To stop that too, mute them on the hashtag (`{ "mute": true }`), or block the words that make the content unwelcome there.
- A hashtag the content doesn't have gets `404`, and so does removing one a second time, or approving the content under a hashtag that was removed from it. Content in the moderation queue gets `404` too: it's for server moderators and admins to decide on first.
- If it's the content's last hashtag, the content stays, and the response is `200` as for any other, with `tags: []`. The content is in no hashtag's feed from then on, and nothing else about it changes: it's still read at `/content`, liked and commented on, and those who follow its publisher still see it. A repost can give it hashtags again, other than the ones removed from it. Its publisher's [notice](#notices) is `last_tag_removed` in place of `tag_removed`.

**Rules apply from when they're set.** A blocked word, a mute or a trust score threshold applies to the posts and updates written after it's set. Content already published keeps its hashtags until its next update: to take it out of a hashtag's feeds, remove the hashtag from it, and to take it down, delete it.

## The CLI download

An instance ships its own [CLI](CLI.md), for anyone to download. None of these endpoints needs a key.

| Endpoint | What it returns |
| --- | --- |
| `GET /cli` | `{ version, build, sha256, size, url, install: { sh, powershell } }`: the CLI the server ships, where to download it, and the two install commands. |
| `GET /cli/evieverse.mjs` | The CLI itself: run it with `node evieverse.mjs`. |
| `GET /cli/install.sh`, `GET /cli/install.ps1` | The install scripts. |

The scripts and `url` use `PUBLIC_BASE_URL` as the server's address, or else the address the request came to. A server run from source (`npm run dev`) has no CLI built, and answers these with `404`: `npm run build` builds both.

The CLI names its build in an `X-Evieverse-CLI` header on every request, and a server that ships another build answers `426` until the CLI has updated itself ([CLI.md](CLI.md#for-everyone)). No other client sends the header, so no other client gets a `426`.
