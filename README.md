# theuniverse

Open source social media server built for read-heavy scale. Publishers store content of any type (text, HTML, PDF, images, video, audio, anything), and declare whether it was created with AI. The publisher or the server picks the hashtags, as the server's [tagging mode](#hashtags) says. Users like content, and readers pull token-budgeted feeds by hashtag, optionally only content created with AI or only content that wasn't.

The design rests on one rule: **the feed never touches the database, and almost never leaves RAM**. Each hashtag has a small index in Redis: per UTC day, the ids of the posts worth showing and their like counts, 30 bytes each. Each post's summary (its feed record, with the start of the post) is stored once as Brotli-compressed plain text: in an object store for the 90-day retention period, and in Redis too while the post is younger than 8 days. `/feed` plans the response from the indexes alone, then fetches the summaries it picked: recent posts, which are most of any feed, from Redis in one round trip, and older ones from the object store.

- **Redis:** any Redis-protocol server with a single primary (Redis 6.2 or later, Valkey, ElastiCache, Memorystore, Azure Managed Redis), set with `REDIS_URL`. It holds the per-hashtag indexes, the summaries of the last 8 days, publisher credits and open [challenges](#challenges). Everything in it but the challenges can be rebuilt from the database and the content store. Without `REDIS_URL`, an in-process store stands in, which only suits a single node.
- **Content store:** uploaded bytes live at `content/<contentId>/<version>`, with a small `<version>.meta.json` beside each. It can be any [Apache OpenDAL](https://opendal.apache.org) backend: local disk, S3 or anything S3-compatible, GCS, Azure Blob, SFTP, WebDAV, Google Drive, OneDrive, Dropbox, HDFS, and more.
- **Summary store:** every summary, at `summaries/<UTC day>/<contentId>/<version>.br`. Any OpenDAL backend; by default, the content store.
- **Database:** SQLite, Postgres, or MySQL (Kysely). It holds users, API keys, content metadata (including the current `version`), the hashtag list, and likes. The schema is portable SQL in [`src/db/migrations`](src/db/migrations), applied on start or with `npm run migrate`.
- **Time:** every timestamp is UTC, stored as epoch milliseconds and returned as ISO-8601 with a `Z` suffix.

## Quick start

Requires Node 22+.

```bash
npm install
npm run dev            # SQLite in ./data, content and summaries in ./data/content, the index in memory
```

Without `REDIS_URL`, the feed index lives inside the process, and the server rebuilds it from the database and the content store each time it starts. To keep it across restarts, point `REDIS_URL` at a local Redis or Valkey (`docker compose up -d redis`, then `REDIS_URL=redis://127.0.0.1:6379`).

To run the full stack in Docker (Postgres, MinIO for content and summaries, Valkey for the index, and a separate compactor): `docker compose --profile app up --build`.

## API

Write endpoints authenticate with `userId` and `apiKey`. Send them in the JSON body or form fields, or as the headers `Authorization: Bearer <apiKey>` and `X-User-Id: <userId>`.

### Challenges

To keep robots out, two kinds of request must show that a person is behind them by solving challenges: registering, and posting less than a minute (`CHALLENGE_POST_WINDOW_SECONDS`) after your previous post or challenge. Such a request is answered with `428`, and nothing is done. The response holds the challenge:

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
- **Posts in a row cost more.** Registering takes one challenge. A post takes more the longer you keep posting without a break:
  - The first post in a run (less than a minute after your previous post) needs one challenge, and so does the second. After that it doubles: 2, 4, 8, 16, and so on. From the second post on, each costs as many challenges as the whole run before it.
  - They're solved one after another. `step` and `steps` say where you are: each right answer is answered with `428` again and the next challenge, until the last one lets the post through. A wrong answer gets a new challenge at the same step.
  - Every challenge starts the minute again, so the run only ends when a minute goes by without a post or a challenge. The next post then needs none, and the run starts over.

  That's aimed at robots that have their challenges solved by paid people or a model. At 10 seconds a challenge, a post that needs 16 takes nearly three minutes, so posting more than about once a minute soon costs far more than waiting.

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

### `POST /register`

```json
{ "username": "Alice", "publisherUrl": "https://alice.example.com" }
```

The first request is answered with a [challenge](#challenges). The same request sent again with its solution returns `201` with `{ userId, username, publisherUrl, apiKey }`. The key is shown only once. This endpoint is rate limited per IP (`REGISTER_RATE_LIMIT_PER_HOUR`, 10 an hour), and every attempt counts, so registering uses at least two.
- `userId` (a UUID) is the user's identity everywhere.
- `username` is a display name and must be unique (exact match). A name already in use returns `409`, before any challenge.
- `publisherUrl` is the credit shown on everything the user publishes. It's required before the user can `POST /store`.

### `GET /users/:userId` and `PATCH /users/:userId`

`GET` returns a public profile. `PATCH` (authenticated, own profile only) updates `username` (still unique, `409` if taken) or `publisherUrl`. Feeds show the new name and URL on all of the user's content at once: they look the credit up in Redis when they render.

### `POST /store`

Creates or updates content. Send it as JSON or as `multipart/form-data` with a file part named `content`.

| field | notes |
| --- | --- |
| `content` | A file (multipart), or a string in JSON. Use `contentEncoding: "base64"` for binary content in JSON. Required. |
| `contentId` | Optional. If set, updates content you own (otherwise 403) and creates a new version, normally `n + 1` (a failed or concurrent update uses up its number, so versions can skip; at most 65,535). Feeds show only the new version straight away, and the compactor erases the older one's bytes and summary on its next run. The new version must have the same content type as the original, otherwise `400`. Content set for deletion can't be updated (`409`), and neither can content another update changed while this one was being stored (`409`; only one of two overlapping updates commits). |
| `tags` | Your hashtags. Required in the default `user` [tagging mode](#hashtags), and ignored in `server` mode. A list (`["news", "mumbai"]`), or one string separated by commas or spaces (`"news, #Mumbai"`, as in a form field). Each is normalised (`#Central-Mumbai` becomes `centralmumbai`); one with nothing usable left, or more than 10, gets `400`. On an update, hashtags that aren't the current version's make a new version, even with the same bytes. |
| `aiGenerated` | Optional. The publisher's declaration that the content was created with AI: `true` or `false` (a JSON boolean, or the string in a form field). Defaults to `false` for new content. An update that leaves it out keeps the current version's value, and changing only this (same bytes) still creates a new version. Feeds return it on every record and can filter on it. |
| `contentType`, `filename` | Optional hints. Otherwise the type comes from the upload or the file extension. |
| `federated_servers` | Optional. Other servers to show the content on, which you have registered with: `{ "serverAddress": "https://b.example.com", "serverUser": "<your username or userId there>", "serverKey": "<your apiKey there>" }`, or a list of up to 10. In a form field, send it as a JSON string. See [federation](#federation). |
| `challengeId`, `challengeAnswer`, `challengeNonce` | The solution of a [challenge](#challenges), when the previous attempt was answered with one. |

The request is synchronous:
1. **If you already posted 3 times in the last minute** (`POST_RATE_LIMIT_PER_MINUTE`), the request is refused with `429` and when to try again ([above](#challenges)), and nothing else is done.
2. **If you posted, or were challenged to, less than a minute ago** (`CHALLENGE_POST_WINDOW_SECONDS`), the request is answered with a [challenge](#challenges) before anything else, and nothing is stored. Send it again with the solution, once per challenge: each post in a row needs more of them. New content and new versions are posts; storing the same content again unchanged isn't. A post that fails doesn't count either, towards the run or the limit. Posts claim their place atomically in the database. So of several sent at once, only one gets through without a challenge, only one of several runs of challenges solved at once gets through, and no more get through than the limit allows.
3. The bytes are written to `content/<id>/<version>`, and the summary, with the [preview](#previews), to the summary store and Redis. An update first reserves its own version number, so overlapping updates never write to the same key.
4. The database row is written and committed. If this fails, nothing is added to any feed, the uploaded bytes and summary are removed, and the request fails.
5. Only then is one index entry pushed onto each hashtag's tail in Redis. If a push fails, the request still succeeds, because the content is stored. The compactor adds the missing entry on its next run.
6. On an update, a tombstone is then pushed onto each of the old version's hashtags, so feeds stop returning it, including under hashtags the new version dropped.
7. With `federated_servers`, the version's feed record is sent to each of those servers.

The response is `{ contentId, version, tags, preview, aiGenerated }`, plus `federated` when `federated_servers` was given.

```bash
curl -X POST localhost:3000/store -H "Authorization: Bearer $KEY" -H "X-User-Id: $USER_ID" -F tags=video,travel -F aiGenerated=true -F content=@clip.mp4
```

### Hashtags

Who chooses a post's hashtags is up to the server, set with `TAGGING_MODE`:

| Mode | A post's hashtags | `tags` sent with a post |
| --- | --- | --- |
| `user` (the default) | The publisher's. | Required, otherwise `400`, before any [challenge](#challenges) |
| `server` | The server's, `TAGGING_SERVER_TAGS`, on every post. | Ignored |

Content [federated](#federation) here keeps the hashtags it arrives with, except in `server` mode, where it gets this server's.

`server` mode is a stand-in for hashtags an admin supplies: for now, one list set in the configuration, which the server checks when it starts.

### Federation

A publisher can show their content in the feeds of other servers without copying it there. They register with each server, then name those servers in `federated_servers` when they `POST /store`. Once the content is stored, this server sends each of them the version's feed record (the same record its own feeds return, with no likes), and its own `PUBLIC_BASE_URL` as the origin. The bytes stay here.

The receiving server indexes the record under the publisher's account there, at `POST /federated`. In its feeds, the record is credited to that account, collects its own likes, and carries an `origin` naming where the content lives:

```json
"origin": { "server": "https://a.example.com", "contentId": "5c06badf-…", "version": 1 }
```

The full content is at `<server>/content/<contentId>/raw`, and the receiving server's own `/content/:contentId/raw` redirects there.

- **Results:** the response's `federated` lists one result per server: `{ serverAddress, ok: true, status, contentId, version }` with the id the content has there, or `{ serverAddress, ok: false, status?, error }`. The content is stored whatever the other servers answer. Each server gets up to `FEDERATION_TIMEOUT_MS` (10 seconds) to answer.
- **Updates:** storing a new version with `federated_servers` updates the copy on each server, which hides the old version from its feeds at once. Storing the same content again (same bytes, with `contentId`) federates the current version, so it adds more servers to existing content, or retries a server that failed. A server that already has the version answers `200` without changing anything.
- **Challenges:** a record federated to a server is a post there. So when it arrives less than a minute after your previous post there, that server answers with a [challenge](#challenges), and its result is `{ serverAddress, ok: false, status: 428, error, challenge }`. To retry, solve the challenge, then store the same content again (with `contentId`), adding `challengeId`, `challengeAnswer` and `challengeNonce` to that server's entry in `federated_servers`. They're passed on to it. When that server wants several challenges, each answer brings the next one back the same way. If you've already posted there as many times in the last minute as it allows, its result is `status: 429`, with when to try again in `error`.
- **Requirements:** this server needs an absolute `PUBLIC_BASE_URL`, which other servers link back to, otherwise `400`. `FEDERATION_ALLOWED_SERVERS` (comma-separated base URLs) limits which servers it sends to; unset, any.
- **Not federated:** likes, which each server counts for itself, and deletions. To remove a copy, `DELETE /content/:contentId` on that server, with the `contentId` from `federated`.

### `POST /federated`

What servers send to federate content here. Authenticated by the publisher's account here: `username` (or `userId`) and `apiKey` in the body. The account needs a `publisherUrl`.

```json
{ "username": "alice", "apiKey": "tu_…", "origin": "https://a.example.com",
  "entry": { "contentId": "…", "version": 1, "mimeType": "text/plain", "aiGenerated": false,
             "preview": { "kind": "text", "text": "…" }, "tags": ["news"],
             "createdAt": "2026-11-10T11:41:16.221Z", … } }
```

- `entry` is a feed record from the origin. Its `publisher`, `likes` and `updatedAt` aren't used. A media preview links to the bytes at the origin. In `server` [tagging mode](#hashtags), its hashtags are replaced by this server's.
- The content gets its own `contentId` here, and keeps its `createdAt` (or now, if that's later). Its version numbers count from 1 here, and `origin.version` is the origin's.
- The first record for a piece of origin content returns `201` with `{ contentId, version, origin, tags, aiGenerated }`. A later origin version updates it (`200`), the same version again returns `{ contentId, version, unchanged: true }`, and an older version is refused (`409`).
- A new record or version is a post, in the same run as the user's posts through `/store`: one less than a minute after the previous post or challenge gets `428` with a [challenge](#challenges), whose solution goes in the body (`challengeId`, `challengeAnswer`, `challengeNonce`). Otherwise robots could post through here without ever solving one. It also counts towards the posts a minute (`POST_RATE_LIMIT_PER_MINUTE`): past them, it gets `429`.
- Federated content can't be updated with `POST /store` (`409`); only its origin sends new versions. It can be liked and deleted like any other content.

### `POST /like`

```json
{ "userId": "...", "apiKey": "...", "contentId": "..." }
```

Each user can like a piece of content once, and likes are permanent. Repeating a like returns `alreadyLiked: true` and doesn't count twice. Returns `{ contentId, likes, alreadyLiked }`. Likes show up in feeds after the next compactor run. Content set for deletion can't be liked (`404`).

### `GET /content/:contentId` (retrieve_content)

Returns the publisher credit first: `publisher: { userId, username, publisherUrl }`. Then come `contentId`, `version`, `preview`, `tags`, `likes`, `aiGenerated`, the file metadata, and `contentUrl`.

`GET /content/:contentId/raw[?version=n]` streams the original bytes of the current version; any other `version` is `404`. On stores that support presigned URLs (S3, GCS, Azure, ...), it redirects to one instead. Federated content also has an `origin`, and `/raw` redirects to its bytes on the origin server.

Both return `404` for content set for deletion.

### `DELETE /content/:contentId`

Authenticated. Only the original publisher can delete content, otherwise `403`. Returns `202` with `{ contentId, status: "pending_deletion", requestedAt }`, and repeating the request returns the same response.

The content disappears at once. A tombstone is pushed onto the tail of every hashtag any of its versions carried, so feeds stop returning it, including on later pages of a feed session that already started. `GET /content` and `/raw` return `404`, likes return `404`, and new versions (`POST /store` with its `contentId`) return `409`.

Nothing is removed from storage straight away. Tombstones live in tails, which the compactor merges and later lets expire, so the content has to be gone from the day indexes first. Instead, the content is set for deletion, and a compactor run removes it from every hashtag's index, then deletes its database row (with its likes) and the bytes and summaries of every version. Repeating the request pushes the tombstones again, which repairs any push that failed.

That run is normally the next one (every `COMPACT_INTERVAL_SECONDS`, 60 by default). Content stored or updated in the last few minutes waits until the tail window holding its entry has closed, because the compactor can't remove a line from an open tail. That's up to `FEED_TAIL_WINDOW_SECONDS` plus twice `COMPACT_GRACE_SECONDS` after the last write (6 minutes by default), plus the wait for the next run.

### `GET /feed?tags=news,mumbai&hours=24` (retrieve_feed)

- `tags`: one or more hashtags (letters, digits, `_`; a leading `#` is fine). Most feeds ask for several.
- `hours`: 1 to 168.
- `mode`: `popular` (the default) or `balanced`.
  - `popular` returns each day's most liked content first: the latest and greatest, for showcasing a tag.
  - `balanced` is for reading: it picks equally from the most liked, middle and least liked thirds of each day.
- `aiGenerated`: optional. `true` returns only content its publisher declared created with AI, `false` only content declared not created with AI. Left out, the feed returns both. Everything below then applies to the matching content alone, so the budget, the turns between tags and the fresh slots are all spent on it.
- `cursor`: optional, taken from the previous page's `nextCursor`.

How the feed is assembled:

1. Time is cut into 24-hour slices counted back from now, and slices are returned newest first.
2. **Budget:** the response is capped at `FEED_MAX_TOKENS` (default 100,000 tokens). Tokens are estimated as bytes divided by 4, about 400,000 characters.
3. **Halving across days:** the newest slice gets 50% of the budget, the next 25%, then 12.5%, and so on. The oldest slice in the window takes what's left.
4. **Carry older:** budget a slice doesn't use goes to the next older slice.
5. **Extend:** if budget remains after the window, the feed keeps reaching back, up to `FEED_MAX_LOOKBACK_DAYS` (default 90). These slices are marked `extended: true`.
6. **Give back:** budget still left goes to the newest slices that had more records than fit.
7. **Within a slice:** the requested tags take turns, so each gets an equal share. Each tag's records are ordered by UTC day, then likes (most first), then recency. Content carrying several requested tags appears once.
8. **Balanced mode:** each UTC day's records of a tag are split by that order into thirds: the most liked, the middle and the least liked. The tag's picks then take turns between them (one from the top third, one from the middle, one from the bottom, and so on), each third in likes order. When a third runs out, the others carry on.
9. **Fresh content (popular mode):** so that new posts on busy tags aren't buried under liked ones (and can earn likes at all), in the newest slice the 2nd pick per tag, and then every `FEED_FRESH_EVERY`th (default 4), is new content with at most `FEED_FRESH_MAX_LIKES` likes (default 0). It's sampled from that tag's `FEED_FRESH_POOL` newest such records (default 200), shuffled with a seed chosen per feed session, so different viewers see different new posts. A fresh slot is skipped once the likes order has already reached unliked content. Older slices are ordered strictly by likes. `FEED_FRESH_EVERY=0` turns this off. Balanced mode has no fresh slots, since the least liked third already gets a third of the picks.

The response shape is:

```
{ window, estimatedTokens, truncated, nextCursor,
  days: [{ from, to, extended, allocatedTokens, usedTokens,
           tags: { "<tag>": [ record, ... ] } }] }
```

Each record is `{ contentId, version, publisher: { userId, username, publisherUrl }, mimeType, aiGenerated, preview, tags, likes, createdAt, updatedAt }`:
- `aiGenerated` is the publisher's declaration of whether the content was created with AI.
- `preview` is either `{ kind: "text", text }` (the first `FEED_PREVIEW_WORDS` words, default 100) or `{ kind: "media", url }`, a link to the image, video, or file. See [previews](#previews).
- `publisher` is the user's current credit, so a renamed user shows under their new name everywhere at once.
- `origin` is only on content [federated](#federation) from another server: `{ server, contentId, version }`, where the content lives.

**Pagination:** the cursor pins the exact day indexes the first page read, plus the mode, the `aiGenerated` filter and the fresh-content seed, so later pages never repeat or skip records, even while new content arrives or the compactor runs. Later pages must ask for the same `tags`, `hours`, `mode` and `aiGenerated`, otherwise `400`. Cursors last `FEED_GEN_RETENTION_MINUTES` (default 60). After that, or for a cursor issued by an earlier release, the server returns `410` and the client should start over.

### `GET /tags?prefix=mum`

Lists hashtags, most recently active first.

## Feed index and summaries

Redis holds, per hashtag (keys are relative to `REDIS_KEY_PREFIX`, default `tu:`):

```
head:news                   { v: 3, manifest, mergedThrough, compactedAt }  (the only index key ever overwritten)
man:news:<id>               every day index's key, quota and count; immutable
day:news:<gen>              one UTC day's posts, sorted by likes then recency, 30 bytes each; immutable
tail:news:<windowStart>     new entries and tombstones, one text line each
tails:news                  the tag's tail windows
```

plus `sum:<contentId>:<version>` (summaries of posts younger than 8 days), `pub:<userId>` (publisher credits) and `compactor:state`.

**Day index entries** are fixed 30-byte binary records: the content id (16 bytes), likes, creation time in seconds, a flags byte (whether it was created with AI, which `aiGenerated` filters on), the size of the rendered record in bytes (which gives its token estimate), and the version. A busy tag at the defaults indexes about 4,200 posts, about 125 KB.

**Summaries** are stored once per content version, shared by all of its hashtags. They're plain text, not JSON, since that compresses better: a short header (version, timestamps and the AI flag, publisher id, MIME type, hashtags, preview kind, and the origin of federated content), then the preview text. They're Brotli-compressed in text mode at quality 11; a typical text summary is a few hundred bytes. Each is written to `summaries/<UTC day>/<contentId>/<version>.br` in the summary store, and to Redis with a TTL that ends when the post turns `SUMMARY_HOT_DAYS` (8) days old. Feeds read summaries of younger posts from Redis, in one `MGET` for the whole page (one Redis has lost is read from the object store and restored), and older ones from the object store, in parallel, with a per-node cache. The compactor deletes a day of summaries once it leaves the retention period.

**Retention:** each hashtag keeps one day index per UTC day for `FEED_TAG_RETENTION_DAYS` (default 90). Each holds that day's best posts (most liked, then newest) up to a quota that halves with age:
- today gets `FEED_TAG_DAY_MAX_TOKENS` (default 100,000), yesterday half that, then a quarter, and so on;
- no day ever drops below `FEED_TAG_DAY_MIN_TOKENS` (default 10,000, about 40 records).

So a flood of new posts can't push out older popular content: each post only competes with posts from its own day. A busy tag indexes about 1M tokens across its 90 days, about 4,200 records.

**Writing (the "prepend"):**
- `/store` pushes one line, `r <contentId> <version> <createdAt> <updatedAt> <size> <flags>`, onto `tail:<tag>:<current 5-minute window>` for each hashtag. Every node pushes onto the same list, and `RPUSH` is atomic.
- Readers treat tails as the newest part of the tag, so the effect is a prepend.
- Deleting content, or replacing a version, pushes a tombstone, `t <contentId> <below|*> <createdAt>`, instead. It hides that content's versions below `below` (every version for `*`).

**Reading:**
- A feed request reads each tag's head, its manifest and day indexes (cached in memory, since they never change), and its open tails (only the last few minutes).
- Entries covered by a tombstone in those tails are never returned. They keep their place in the ordering, so cursors written before the tombstone arrived still point at the same records.
- It plans the response from the index alone, then loads the picked summaries and the publishers' credits and streams the records.
- The database is not involved.

**Compaction** (`npm run compact`, or in-process with `COMPACT_IN_PROCESS=true`) runs every `COMPACT_INTERVAL_SECONDS`. It rebuilds only the day indexes that changed. A day index is rebuilt when:
- it has new entries from closed tail windows;
- content from that day was liked;
- content from that day had a version replaced, under the replaced version's hashtags;
- a version from that day was committed, but its tail push failed or never ran;
- content from that day was set for deletion, under the hashtags of every version;
- a closed tail window holds a tombstone for content from that day;
- the day's quota has shrunk with age since the index was written.

To rebuild a day index, it:
1. merges the day's current index with that day's entries from the closed tails;
2. refreshes each entry's `likes` from the database;
3. rebuilds the current version's entry from the database and the content's metadata file, and restores its summary in whichever tier lacks it, in three cases:
   - liked content that an earlier compaction trimmed;
   - versions whose tail push failed;
   - entries that aren't the version the database holds.

   Content re-tagged away from this hashtag is dropped instead;
4. sorts by likes, then recency, and keeps what fits in the day's quota.

Other days' indexes are carried over unchanged, and days past retention are dropped. It then writes a new manifest and swaps the head. Content set for deletion is dropped from every rebuilt index. Once all of its hashtags have compacted, its database row, bytes and summaries are deleted. Likewise, once every hashtag of a replaced version has compacted, that version's bytes and summary are erased, so even several updates in a row leave only the current version behind.

Readers are never locked out. A reader that started with the old head keeps reading the old keys: instead of deleting them, the compactor lets them expire after the cursor lifetime.

Compactor runs never overlap. A run that published after a newer one could bring back content the newer run had already deleted, so each run takes a lease in the database first, and a run that finds it held skips. The lease lasts `COMPACT_LEASE_SECONDS` (300 by default) and is renewed as the run goes. A run that lost it, for example after stalling, stops before publishing or deleting anything more.

**Rebuilding:** `npm run compact -- --once --rebuild` rebuilds everything Redis holds from the database and the content store's meta files: every post within retention under each of its hashtags, its summary in both tiers, and every publisher credit. Run it after Redis loses data, or once to migrate from the tag files of earlier releases, whose tag store is no longer read. `npm run compact -- --once --all` only rebuilds every day of every tag from the existing index.

## Deploying

Ready-made Terraform for AWS, GCP and Azure is in [`deploy/`](deploy/README.md). Each one builds the image, provisions everything, and prints the HTTPS URL.

Rules that apply on every cloud:
- **Content and summaries** go in the cloud's ordinary object store. Summaries share the content bucket, under `summaries/`, unless `SUMMARY_SCHEME` and `SUMMARY_OPTIONS` point elsewhere.
- **Redis** is one primary (with a replica for failover), shared by every API node and the compactor through `REDIS_URL`:
  - Use a `volatile-*` eviction policy, such as `volatile-lru`. Only hot summaries and superseded keys have a TTL, so under memory pressure Redis drops summaries, which are then read from the object store, and never the index.
  - Redis Cluster (cluster mode enabled) isn't supported, because the app sends multi-key commands across tags. A proxy that presents one endpoint and splits multi-key commands (Azure Managed Redis's Enterprise cluster policy) works.
  - Persistence is optional: `--rebuild` restores everything, but with RDB or AOF snapshots a restart needs nothing.
  - Size it for about 30 bytes per indexed post per hashtag, plus about 0.4 KB per post of the last 8 days. See [APP.md](APP.md#12-performance-and-scale).
- **The compactor** runs as one instance, either a scheduled job or one node with `COMPACT_IN_PROCESS=true`. Every other node should have `COMPACT_IN_PROCESS=false`. A second instance can't do harm, since runs take turns through a lease in the database, but its runs just skip.

### AWS

| Piece | Recommended | Alternatives |
| --- | --- | --- |
| Content and summaries | S3: `CONTENT_SCHEME=s3`, `CONTENT_OPTIONS='{"bucket":"tu-content","region":"us-east-1"}'` | |
| Redis | **ElastiCache for Valkey or Redis OSS**, cluster mode disabled, with a replica: `REDIS_URL=rediss://:<auth token>@<primary endpoint>:6379` | Valkey or Redis on EC2 |
| API | EC2 Auto Scaling or ECS Fargate behind an ALB | EKS |
| Compactor | ECS scheduled task (EventBridge Scheduler) running `npm run compact -- --once` | A long-running ECS service running `npm run compact` |
| Database | RDS PostgreSQL or MySQL | Aurora |

ElastiCache Serverless and MemoryDB only run in cluster mode, so they aren't supported.

### Google Cloud

| Piece | Recommended | Alternatives |
| --- | --- | --- |
| Content and summaries | Cloud Storage: `CONTENT_SCHEME=gcs`, `CONTENT_OPTIONS='{"bucket":"tu-content","credential_path":"/secrets/gcs.json"}'` | |
| Redis | **Memorystore for Redis**, Standard tier, with AUTH: `REDIS_URL=redis://:<auth string>@<host>:6379` | Valkey or Redis on Compute Engine |
| API | Cloud Run with direct VPC egress, a Managed Instance Group, or GKE, behind a Cloud Load Balancer | |
| Compactor | Kubernetes CronJob, or Cloud Scheduler triggering a Cloud Run job, running `--once` | |
| Database | Cloud SQL for PostgreSQL or MySQL | AlloyDB |

Memorystore for Redis Cluster runs in cluster mode, so it isn't supported.

### Azure

| Piece | Recommended | Alternatives |
| --- | --- | --- |
| Content and summaries | Blob Storage: `CONTENT_SCHEME=azblob`, `CONTENT_OPTIONS='{"container":"content","endpoint":"https://acct.blob.core.windows.net","account_name":"acct","account_key":"..."}'` | |
| Redis | **Azure Managed Redis** with the Enterprise cluster policy: `REDIS_URL=rediss://:<access key>@<host>:10000` | Azure Cache for Redis, without clustering |
| API | VM Scale Sets, AKS, or Container Apps behind Front Door or an Application Gateway | |
| Compactor | Container Apps scheduled job or an AKS CronJob running `--once` | |
| Database | Azure Database for PostgreSQL or MySQL Flexible Server | |

## Previews

| Type | Preview |
| --- | --- |
| Text, HTML, JSON, XML, PDF | The first `FEED_PREVIEW_WORDS` words (default 100) of its text: HTML without its markup, a PDF's extracted text (none for one over 200 MB) |
| Anything else (images, video, audio, other files) | A link to the bytes |

A document whose text can't be read, or has none, gets a link too.

## Configuration

Settings come from environment variables, or from `theuniverse.config.json` (nested keys; see `src/config.ts`). Environment variables take precedence.

| Variable | Default |
| --- | --- |
| `PORT`, `HOST` | `3000`, `0.0.0.0` |
| `DB_DIALECT`, `DATABASE_URL` | `sqlite`, `./data/theuniverse.sqlite` |
| `CONTENT_SCHEME`, `CONTENT_OPTIONS` (JSON) | `fs`, `{"root":"./data/content"}` |
| `REDIS_URL` (`redis://` or `rediss://`), `REDIS_KEY_PREFIX` | unset (an in-process store, single node only), `tu:` |
| `SUMMARY_SCHEME`, `SUMMARY_OPTIONS` (JSON) | unset (the content store) |
| `SUMMARY_HOT_DAYS` (summaries of younger posts are also kept in Redis) | `8` |
| `SUMMARY_BROTLI_QUALITY`, `SUMMARY_CACHE_SIZE` (summaries from the object store kept in memory per node) | `11`, `20000` |
| `PUBLIC_BASE_URL` | empty (media links are relative) |
| `MAX_UPLOAD_BYTES` | 5 GiB |
| `TAGGING_MODE` (who picks the [hashtags](#hashtags): `user` or `server`) | `user` |
| `TAGGING_SERVER_TAGS` (every post's hashtags in `server` mode, separated by commas or spaces; required there) | unset |
| `FEED_MAX_TOKENS`, `CHARS_PER_TOKEN` | `100000`, `4` |
| `FEED_TAG_DAY_MAX_TOKENS`, `FEED_TAG_DAY_MIN_TOKENS`, `FEED_TAG_RETENTION_DAYS` | `100000`, `10000`, `90` |
| `FEED_MAX_LOOKBACK_DAYS`, `FEED_PREVIEW_WORDS` | `90`, `100` |
| `FEED_FRESH_EVERY`, `FEED_FRESH_MAX_LIKES`, `FEED_FRESH_POOL` | `4`, `0`, `200` |
| `FEED_TAIL_WINDOW_SECONDS` | `300` |
| `FEED_GEN_RETENTION_MINUTES` (also the cursor lifetime) | `60` |
| `FEED_HEAD_CACHE_MS` (heads, tail windows and publisher credits), `FEED_INDEX_CACHE_SIZE` (tags whose manifest and day indexes each node keeps in memory) | `1000`, `500` |
| `COMPACT_IN_PROCESS`, `COMPACT_INTERVAL_SECONDS`, `COMPACT_GRACE_SECONDS` | `true`, `60`, `30` |
| `COMPACT_LEASE_SECONDS` (keeps compactor runs from overlapping; a crashed run delays the next by up to this long) | `300` |
| `FEDERATION_TIMEOUT_MS` (how long `/store` waits for each server it federates to) | `10000` |
| `FEDERATION_ALLOWED_SERVERS` (comma-separated base URLs `/store` may federate to) | unset (any) |
| `CHALLENGE_REGISTER` (whether `/register` needs a [challenge](#challenges)) | `true` |
| `CHALLENGE_POST_WINDOW_SECONDS` (a post this soon after the user's previous post or challenge needs challenges, more for each post in a row; `0` never) | `60` |
| `CHALLENGE_TTL_SECONDS` (how long a challenge can be solved for), `CHALLENGE_POW_BITS` (proof-of-work difficulty; each bit doubles it) | `120`, `18` |
| `CHALLENGE_MIN_SOLVE_MS` (answers sooner than this are refused) | `2000` |
| `REGISTER_RATE_LIMIT_PER_HOUR` (per IP, per node; every attempt counts) | `10` |
| `POST_RATE_LIMIT_PER_MINUTE` (a user's posts past this many in any minute get `429`, before any challenge; shared by all nodes; `0` no limit) | `3` |

## Development

```bash
npm test     # unit tests, migration tests, API and feed-index tests on SQLite with the in-process store
docker compose up -d postgres mysql redis
TEST_POSTGRES_URL=postgres://theuniverse:theuniverse@localhost:5432/theuniverse \
TEST_MYSQL_URL=mysql://theuniverse:theuniverse@localhost:3306/theuniverse \
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

Each test against Redis uses its own key prefix and deletes its keys afterwards, so any Redis or Valkey will do.

Known limits:
- Likes, and a version whose tail push failed after its commit, reach feeds only on the next compactor run.
- If a tombstone push fails (logged as a warning), the deleted content or replaced version stays in that hashtag's feed until the compactor removes it, though `/content` and `/raw` already return `404` for it.
- Feeds and `/store` need Redis: there's no fallback while it's down.
- Balanced feeds split what each day index keeps. A busy tag's older days keep only their most liked posts, so there the least liked third means the least liked of those.
- Feeds filtered by `aiGenerated` also choose from what each day index keeps. On a busy tag's older days, where only the most liked posts are kept, a filtered feed can find fewer matching posts than the tag once had.
- `aiGenerated` is the publisher's own declaration: nothing checks it.
- There is no endpoint to rotate API keys.
- A server receiving federated content checks only the publisher's account there, not that the content exists on the origin.
- Outside `server` mode, federated content keeps the hashtags it arrives with, whoever chose them on the origin. So on a `user` server, a federated post can carry hashtags its publisher didn't choose: its origin's `TAGGING_SERVER_TAGS`, or an AI's on an origin still running an earlier release.
- Servers on releases with an AI require the summary it wrote in what they receive, so they refuse content federated from this release (`400`) until they upgrade.
- `federated_servers` makes this server send requests to addresses its users choose. Set `FEDERATION_ALLOWED_SERVERS` if it can reach services that shouldn't receive them.
- Deleting content doesn't delete its federated copies.
- Challenges slow robots down, but can't stop all of them. Machine-learning models can read distorted characters some of the time, people can be paid to solve challenges for a robot, and native code does the proof of work far faster than a browser. What they add is a cost: every attempt needs a new image read and a new proof of work done.
- There's no audio alternative to the challenge image, so people who can't see it can't register, or post more than once a minute.
- A post that needs challenges is refused before its upload is used, so a file is uploaded again with every answer.
- The limit on posts a minute is per user, and each server counts only the posts made on it. A robot with many accounts can post that much more, which is part of why registering needs a challenge and is limited per IP.
