# Configuring an Evieverse server

This is the reference for every setting a server has, and for putting a changed setting into effect on a running instance, on your own machine or in the cloud.

- [How settings are read](#how-settings-are-read)
- [How to write a value](#how-to-write-a-value)
- [A. Settings](#a-settings)
- [B. Deploying a change](#b-deploying-a-change)
  - [Local](#local)
  - [Cloud](#cloud)

`[.env.example](../.env.example)` lists the same settings as a file you can copy to `.env`, and `[src/config.ts](../src/config.ts)` is where they are read and checked.

## Configuration settings not described here.

Please see separate documents for the languages the server answers in ([LANGUAGES.md](LANGUAGES.md)) and the trust plugins that score posts ([TRUST_PLUGINS.md](TRUST_PLUGINS.md)).

## How settings are read

Methods of supplying configuration settings:

1. **Environment variables.** Supplied via: `node --env-file=.env dist/server.js`, Docker Compose's `env_file:` or `environment:`, `terraform.tfvars` on the Terraform modules, or your platform's own settings.
2. **JSON file of nested keys (local only),** named by `EVIEVERSE_CONFIG` (`evieverse.config.json` by default, and read only if it exists). The *File key* column below gives each setting's place in it: `FEED_PAGE_SIZE` is `{ "feed": { "pageSize": 25 } }`. The container image doesn't contain such a file, so in Docker you'd mount one and set `EVIEVERSE_CONFIG`.

Only the first of the three that sets a variable counts, so an environment variable always overrides the file, even where it only repeats the default.

On a deployment made with the [Terraform modules](DEPLOY.md) there may be overlap between variables. See [Deploying a change](#with-the-terraform-modules).

## How to write a value

Each setting in the tables has a *Format*:


| Format         | Write it as                                                                                                                            | Example                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **text**       | Plain text.                                                                                                                            | `LOG_LEVEL=debug`                                                |
| **number**     | A whole number. Where the description says "0: none", "0: off" or "0: no limit", 0 is allowed; otherwise a setting must be at least 1. | `PORT=8080`                                                      |
| **true/false** | `true`, `1` or `yes` for true. Anything else is false.                                                                                 | `DB_MIGRATE_ON_START=false`                                      |
| **choice**     | One of the words the description lists.                                                                                                | `TAGGING_MODE=server`                                            |
| **list**       | Items separated by commas, spaces, or both.                                                                                            | `CORS_ORIGINS=https://app.example.com,http://localhost:5173`     |
| **JSON**       | A JSON object on one line, in single quotes in a shell or `.env` file, so the shell leaves the double quotes alone.                    | `CONTENT_OPTIONS='{"bucket":"tu-content","region":"us-east-1"}'` |


`TRUST_PROXY` is the one that takes more than one format: a number, `true`, or a list of addresses (the table says which).

**Where you write it changes the quoting:**

```sh
# .env file, or a shell
CORS_ORIGINS=https://app.example.com,http://localhost:5173
CONTENT_OPTIONS='{"bucket":"tu-content","region":"us-east-1"}'
```

```yaml
# Docker Compose, in a service's environment:
CORS_ORIGINS: https://app.example.com,http://localhost:5173
CONTENT_OPTIONS: '{"bucket":"tu-content","region":"us-east-1"}'
```

```hcl
# terraform.tfvars: every value is a string, so numbers and booleans are quoted too, and the double quotes inside JSON are escaped
environment = {
  CORS_ORIGINS               = "https://app.example.com,http://localhost:5173"
  POST_RATE_LIMIT_PER_MINUTE = "5"
}
secrets = {
  SUMMARY_OPTIONS = "{\"bucket\":\"summaries\",\"access_key_id\":\"...\",\"secret_access_key\":\"...\"}"
}
```

In `evieverse.config.json` the values are real JSON types: a list is an array, and an options object is an object, not a string.

```json
{
  "corsOrigins": ["https://app.example.com", "http://localhost:5173"],
  "feed": { "pageSize": 25 },
  "storage": { "content": { "scheme": "s3", "options": { "bucket": "tu-content", "region": "us-east-1" } } }
}
```

In the file, `TRUST_PROXY` (`trustProxy`) is a number, `true` or a string, so a list of addresses is one string: `"trustProxy": "10.0.0.0/8, 127.0.0.1"`. `BOOTSTRAP_ADMIN`, `FUNCTION_GROUP`, `FUNCTION_EDGE_SECRET` and `EVIEVERSE_CONFIG` are environment-only and have no file key.

## A. Settings



### Server


| Variable               | File key          | Format                  | Default                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------- | ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                 | `host`            | text                    | `0.0.0.0`               | The address the server listens on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PORT`                 | `port`            | number                  | `3000`                  | The port it listens on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `LOG_LEVEL`            | `logLevel`        | choice                  | `info`                  | A pino level: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PUBLIC_BASE_URL`      | `publicBaseUrl`   | text                    | empty                   | The absolute address of the instance, such as `https://api.example.com`. Links to images, video and audio in feeds are built from it, when the feed is read. Empty: relative links.                                                                                                                                                                                                                                                                                                                           |
| `CORS_ORIGINS`         | `corsOrigins`     | list                    | empty                   | Origins whose pages may call the API from a browser, such as `https://app.example.com http://localhost:5173`, or `*` for any. Each must be a scheme, host and port only. Empty: none, so only pages on the API's own origin can.                                                                                                                                                                                                                                                                              |
| `TRUST_PROXY`          | `trustProxy`      | number, `true`, or list | empty                   | The proxies in front of the server whose `X-Forwarded-For` is believed, which decides the client address that per-address limits count by. A number is how many proxies there are (`1` behind one load balancer), `true` is any, and a list is their addresses and CIDR ranges (`10.0.0.0/8,127.0.0.1`). Empty: none, so the address is the connection's own. Give a number only where nothing can reach the server except through those proxies, or anyone connecting directly can choose their own address. |
| `DEFAULT_LANGUAGE`     | `defaultLanguage` | text                    | `en`                    | The code of the language the server answers in when a request asks for none it has, and users register in when they choose none. It must be a file of `[languages](../languages)`, or the server doesn't start ([Languages](LANGUAGES.md)).                                                                                                                                                                                                                                                                   |
| `EVIEVERSE_MODIFIED`   | `modified`        | true/false              | `false`                 | The modification disclosure: `true` if this instance runs a modified version of Evieverse, one whose source code differs from a release, as Evieverse's [additional license terms](../LICENSE.md) define it. Those terms have a modified version say so, and setting this is the supported way. `[GET /rules](API.md#get-rules)` gives it to anyone, with the release the code is based on. It's your own statement: the server checks it against nothing.                                                    |
| `EVIEVERSE_SOURCE_URL` | `sourceUrl`       | text (a URL)            | empty                   | Where the source code this instance runs can be obtained: an `http` or `https` address, which `GET /rules` gives with the disclosure. A modified version has to give one, so a server with `EVIEVERSE_MODIFIED=true` and no address doesn't start. Empty: none is given.                                                                                                                                                                                                                                      |
| `SUPPORT_EMAIL`        | `supportEmail`    | text (an email address) | `noreply@yoururl.com`   | The email address people write to for support, which `[GET /rules](API.md#get-rules)` gives to anyone who asks, beside the server's rules. The default is a placeholder: set it to an address that someone reads. The server sends it nothing, and doesn't start if it isn't an email address. Empty: the default.                                                                                                                                                                                            |
| `EVIEVERSE_CONFIG`     |                   | text (a path)           | `evieverse.config.json` | The JSON file of settings. Environment only: a file can't name itself.                                                                                                                                                                                                                                                                                                                                                                                                                                        |




### Database


| Variable              | File key            | Format     | Default                   | What it does                                                                                                                                          |
| --------------------- | ------------------- | ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_DIALECT`          | `db.dialect`        | choice     | `sqlite`                  | `sqlite`, `postgres` or `mysql`.                                                                                                                      |
| `DATABASE_URL`        | `db.url`            | text       | `./data/evieverse.sqlite` | A file path (or `:memory:`) for SQLite, or a connection URL for Postgres or MySQL, such as `postgres://evieverse:evieverse@localhost:5432/evieverse`. |
| `DB_POOL_SIZE`        | `db.poolSize`       | number     | `10`                      | Connections each process keeps open at most.                                                                                                          |
| `DB_IDLE_TIMEOUT_MS`  | `db.idleTimeoutMs`  | number     | the driver's              | Close connections idle this long, in milliseconds (Postgres, MySQL).                                                                                  |
| `DB_MIGRATE_ON_START` | `db.migrateOnStart` | true/false | `true`                    | Bring the schema up to date whenever a process opens the database. `false`: run `npm run migrate` when you deploy.                                    |
| `BOOTSTRAP_ADMIN`     |                     | JSON       | unset                     | Read only by `npm run migrate` and the migrate step of a deployment, not by the server. See [below](#bootstrap_admin).                                |




### Redis


| Variable           | File key          | Format | Default | What it does                                                                                                                                                                                 |
| ------------------ | ----------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`        | `redis.url`       | text   | unset   | A `redis://` or `rediss://` URL of any Redis-protocol server, not in cluster mode, with a `volatile-*` eviction policy (`volatile-lru`). Unset: an in-process store, for a single node only. |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` | text   | `tu:`   | Put in front of every key, so instances can share a Redis.                                                                                                                                   |




### Content and summary stores


| Variable                     | File key                           | Format | Default                     | What it does                                                                                                                                      |
| ---------------------------- | ---------------------------------- | ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTENT_SCHEME`             | `storage.content.scheme`           | text   | `fs`                        | Where each post's bytes and metadata file are kept: any Apache OpenDAL scheme (`fs`, `s3`, `gcs`, `azblob`, `sftp`, `webdav`, ...).               |
| `CONTENT_OPTIONS`            | `storage.content.options`          | JSON   | `{"root":"./data/content"}` | The scheme's options, such as `{"bucket":"tu-content","region":"us-east-1"}`. In the JSON file, an object.                                        |
| `CONTENT_SIGNED_URL_SECONDS` | `storage.content.signedUrlSeconds` | number | `900`                       | How long the signed links to stored bytes last, and the links `POST /uploads` gives to upload a file with.                                        |
| `SUMMARY_SCHEME`             | `storage.summaries.scheme`         | text   | unset                       | Where the Brotli-compressed summaries for the whole retention period are kept, as `CONTENT_SCHEME`. Unset: the content store, under `summaries/`. |
| `SUMMARY_OPTIONS`            | `storage.summaries.options`        | JSON   | unset                       | The same, for the summary store. It's where credentials go, so on a deployment it belongs in `secrets`.                                           |
| `SUMMARY_HOT_DAYS`           | `feed.summaryHotDays`              | number | `8`                         | Summaries of posts younger than this many days are also kept in Redis; older ones are read from the summary store.                                |
| `SUMMARY_BROTLI_QUALITY`     | `feed.summaryBrotliQuality`        | number | `11`                        | Brotli quality of stored summaries, 0 to 11.                                                                                                      |
| `SUMMARY_CACHE_SIZE`         | `feed.summaryCacheSize`            | number | `20000`                     | Summaries read from the summary store that each node keeps in memory (0: none).                                                                   |
| `SUMMARY_CACHE_SECONDS`      | `feed.summaryCacheSeconds`         | number | `60`                        | How long each is kept. A post older than `SUMMARY_HOT_DAYS` can show as it was before an update for this long (0: not kept).                      |




### Audit log

Every request that adds, updates or deletes something successfully is written to the audit log before the response is sent. Each record is one gzipped JSON object stored by UTC hour (`2026/11/14/20/<epoch ms>-<id>.json.gz`). 


| Variable        | File key        | Format | Default | What it does                                                                                                                                        |
| --------------- | --------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUDIT_SCHEME`  | `audit.scheme`  | text   | unset   | Where the audit log is kept: any Apache OpenDAL scheme (`fs`, `s3`, `gcs`, `azblob`, ...). Unset: nothing is written. The Terraform modules set it. |
| `AUDIT_OPTIONS` | `audit.options` | JSON   | unset   | The scheme's options, such as `{"bucket":"tu-audit","region":"us-east-1"}`. It's where credentials go, so on a deployment it belongs in `secrets`.  |


The server only writes records. Moving them to cold storage is the bucket's own lifecycle rule, which the Terraform modules set up ([DEPLOY.md](DEPLOY.md#audit-log)).

### Uploads


| Variable                  | File key                       | Format        | Default                               | What it does                                                                                                                                                  |
| ------------------------- | ------------------------------ | ------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`        | `storage.maxUploadBytes`       | number        | `5368709120` (5 GiB)                  | The largest image, video or audio file accepted. The Terraform modules set it lower where a request's time limit calls for it ([Uploads](DEPLOY.md#uploads)). |
| `STORAGE_TMP_PATH`        | `storage.tmpPath`              | text (a path) | `evieverse/` in the OS temp directory | Where uploads are kept while they arrive.                                                                                                                     |
| `UPLOAD_LINKS_PER_MINUTE` | `storage.uploadLinksPerMinute` | number        | `10`                                  | Upload links (`POST /uploads`) one user can ask for in a minute, across all nodes (0: no limit).                                                              |




### Hashtags


| Variable              | File key             | Format | Default | What it does                                                                                                                                                                                   |
| --------------------- | -------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAGGING_MODE`        | `tagging.mode`       | choice | `user`  | `user`: a post can have any hashtags. `server`: only those of `TAGGING_SERVER_TAGS`, and a post with another is refused.                                                                       |
| `TAGGING_SERVER_TAGS` | `tagging.serverTags` | list   | empty   | The hashtags posts can have in server mode, as many as you like, such as `news,local,sports`. Required in server mode, which doesn't start without one. `GET /tagging` lists them for clients. |




### Post types


Which [types of post](API.md#post-store) the server takes: all five by default. `false` turns one off, and at least one must stay on, or the server doesn't start: a server of pictures alone sets every one but `POST_TYPE_IMAGE` to `false`. A type that's off takes no new post and no update of one (`400`), and `POST /uploads` gives no link for its files. Posts of it the server already holds stay, to read, like and delete.

| Variable          | File key          | Format     | Default | What it does                                                                                                              |
| ----------------- | ----------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST_TYPE_TEXT`  | `postTypes.text`  | true/false | `true`  | Whether the server takes text posts. A comment's text is no text post, so comments are written whether this is on or off. |
| `POST_TYPE_IMAGE` | `postTypes.image` | true/false | `true`  | Whether it takes image posts, and comments that come with an image.                                                       |
| `POST_TYPE_VIDEO` | `postTypes.video` | true/false | `true`  | Whether it takes video posts, and comments that come with a video.                                                        |
| `POST_TYPE_AUDIO` | `postTypes.audio` | true/false | `true`  | Whether it takes audio posts.                                                                                             |
| `POST_TYPE_LINK`  | `postTypes.link`  | true/false | `true`  | Whether it takes link posts.                                                                                              |




### Reposts


| Variable         | File key          | Format     | Default | What it does                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPOSTS`        | `reposts.enabled` | true/false | `true`  | Whether the server takes reposts (`POST /repost`): a user gives a post more hashtags, which puts it in those hashtags' feeds and in the following feeds of their own followers, as a new post there. The post isn't copied. `false`: `POST /repost` is refused (`400`), and what was reposted before stays as it is. |
| `REPOSTS_REMOTE` | `reposts.remote`  | true/false | `true`  | Whether it also takes reposts of posts on other servers. Such a repost is stored as a link to the original with the original's summary, which the reposter's client sends: this server asks the other one nothing. `false`: only posts on this server are reposted.                                                  |




### Feeds


| Variable                    | File key                    | Format | Default | What it does                                                                                                                                                                    |
| --------------------------- | --------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEED_PAGE_SIZE`            | `feed.pageSize`             | number | `50`    | Posts per feed page when the request passes no `limit`. At most `FEED_MAX_PAGE_SIZE`.                                                                                           |
| `FEED_MAX_PAGE_SIZE`        | `feed.maxPageSize`          | number | `100`   | The largest `limit` a request may pass.                                                                                                                                         |
| `FEED_TAG_DAY_MAX_POSTS`    | `feed.tagDayMaxPosts`       | number | `400`   | Posts a hashtag's index keeps for today. Each older UTC day keeps half the previous day's, down to the minimum.                                                                 |
| `FEED_TAG_DAY_MIN_POSTS`    | `feed.tagDayMinPosts`       | number | `40`    | The fewest a day keeps.                                                                                                                                                         |
| `FEED_TAG_RETENTION_DAYS`   | `feed.tagRetentionDays`     | number | `90`    | UTC days a hashtag's index keeps, and summaries are stored (capped at `FEED_MAX_LOOKBACK_DAYS`).                                                                                |
| `FEED_AUTHOR_DAY_MAX_POSTS` | `feed.authorDayMaxPosts`    | number | `1000`  | Posts each publisher's own index, which following feeds read, keeps per UTC day: the newest, whatever their likes.                                                              |
| `FEED_MAX_LOOKBACK_DAYS`    | `feed.maxLookbackDays`      | number | `90`    | How far back, in days, a following feed reaches, and the longest a hashtag's index is kept. At least 7. A hashtag feed is of the window it asks for, which this doesn't change. |
| `FEED_PREVIEW_WORDS`        | `feed.previewWords`         | number | `100`   | Words of a text post or caption copied into each record's preview...                                                                                                            |
| `FEED_PREVIEW_CHARS`        | `feed.previewChars`         | number | `1000`  | ...and at most this many characters of them, which bounds text written without spaces.                                                                                          |
| `FEED_FRESH_EVERY`          | `feed.freshEvery`           | number | `4`     | In a popular feed, one in this many picks per hashtag is new, low-like content (0: off).                                                                                        |
| `FEED_FRESH_MAX_LIKES`      | `feed.freshMaxLikes`        | number | `0`     | Records with at most this many likes count as fresh.                                                                                                                            |
| `FEED_FRESH_POOL`           | `feed.freshPool`            | number | `200`   | Fresh picks are sampled per feed session from this many of the newest eligible records per hashtag in the feed's window.                                                        |
| `FEED_RELATED_TAGS`         | `feed.relatedTags`          | number | `3`     | A feed asked to add related hashtags adds at most this many for each hashtag asked for, the most related first (0: none).                                                       |
| `FEED_RELATED_MIN_POSTS`    | `feed.relatedMinPosts`      | number | `5`     | A hashtag is related to another once at least this many posts carry both...                                                                                                     |
| `FEED_RELATED_MIN_PERCENT`  | `feed.relatedMinPercent`    | number | `20`    | ...and those are at least this percent, 0 to 100, of the posts that carry the other.                                                                                            |
| `FEED_HEAD_CACHE_MS`        | `feed.headCacheMs`          | number | `1000`  | How long each node caches a hashtag's head, its related hashtags and publisher credits (0: no cache). The index keys a compactor run replaces are kept this long and a minute.  |
| `FEED_INDEX_CACHE_SIZE`     | `feed.indexCacheSize`       | number | `500`   | Hashtags whose manifest and day indexes each node keeps in memory.                                                                                                              |
| `FEED_AUTHOR_CACHE_SIZE`    | `feed.authorIndexCacheSize` | number | `5000`  | The same for publishers' own indexes, which following feeds read: one per user followed.                                                                                        |




### Monetization

The server can show the ads its admins keep (`/monetization/ads`), each with the word "Sponsored". Both ways of showing them are off by default, and each has its own setting. Admins can keep ads whichever is on: with both off, the server shows none.


| Variable                | File key               | Format     | Default | What it does                                                                                                                                               |
| ----------------------- | ---------------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONETIZATION_FEED_ADS` | `monetization.feedAds` | true/false | `false` | `true`: each page of a hashtag feed (`[GET /feed](API.md#get-feed)`) comes with ads to show before its 3rd, 10th and 17th post. Following feeds have none. |
| `MONETIZATION_POST_ADS` | `monetization.postAds` | true/false | `false` | `true`: a post (`[GET /content/:contentId](API.md#get-contentcontentid)`) comes with an ad to show at its end.                                             |


The compactor needs the same two settings as the API. It publishes the ads to Redis, where feeds and posts read them, and only where one of the two is on. With both off it skips that, and reads nothing for it. The compose files and the Terraform modules' `environment` give the API and the compactor the same settings. Where you run the compactor yourself, set them for it too: with them on for the API alone, a new ad isn't shown, and one that was changed or deleted shows as it last was.

### Compactor


| Variable                   | File key                  | Format     | Default | What it does                                                                                                                                                                           |
| -------------------------- | ------------------------- | ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPACT_IN_PROCESS`       | `compact.inProcess`       | true/false | `true`  | Run the compactor inside the API process. Enable it on one node only, or set `false` everywhere and run `npm run compact` as a process of its own, as the Terraform modules do.        |
| `COMPACT_INTERVAL_SECONDS` | `compact.intervalSeconds` | number     | `5`     | A pass starts this long after the previous one started, or as soon as that one ends if it took longer. It's the longest a new post waits to be in feeds, plus the pass itself.         |
| `COMPACT_GRACE_SECONDS`    | `compact.graceSeconds`    | number     | `30`    | Related-hashtag counts are read once they're this old, which covers clock skew between nodes, and an update that stopped before its commit is repaired in the index after this long.   |
| `COMPACT_CONCURRENCY`      | `compact.concurrency`     | number     | `4`     | Batches of indexes compacted in parallel. A batch is 200 hashtags' or publishers' indexes, read and written together.                                                                  |
| `COMPACT_LEASE_SECONDS`    | `compact.leaseSeconds`    | number     | `60`    | The lifetime of the database lease that keeps two compactors' passes from overlapping. At least 30. A process that stops without releasing it delays the next pass by up to this long. |




### Challenges and rate limits


| Variable                        | File key                      | Format | Default | What it does                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHALLENGE_POST_WINDOW_SECONDS` | `challenge.postWindowSeconds` | number | `60`    | A post less than this long after the user's previous post or challenge must solve a challenge, or two from the third such post in a row (0: never).                                                                              |
| `CHALLENGE_COMMENTS_PER_MINUTE` | `challenge.commentsPerMinute` | number | `3`     | A user's comment past this many in any minute must solve a challenge, or two from the third such comment in a row (0: never). Edits of comments count as comments.                                                               |
| `CHALLENGE_TTL_SECONDS`         | `challenge.ttlSeconds`        | number | `120`   | How long a challenge can be solved for.                                                                                                                                                                                          |
| `CHALLENGE_POW_BITS`            | `challenge.powBits`           | number | `18`    | Zero bits the proof of work's SHA-256 must start with, 0 to 32. Each doubles the client's work (0: none).                                                                                                                        |
| `CHALLENGE_MIN_SOLVE_MS`        | `challenge.minSolveMs`        | number | `2000`  | Answers sent sooner than this after the challenge was issued are refused.                                                                                                                                                        |
| `REGISTER_RATE_LIMIT_PER_HOUR`  | `registerRateLimitPerHour`    | number | `10`    | Registration requests from one address in an hour, every attempt counted, an admin's included. Shared by all nodes when `REDIS_URL` is set. Behind a load balancer, also set `TRUST_PROXY`, or every client counts as the proxy. |
| `POST_RATE_LIMIT_PER_MINUTE`    | `postRateLimitPerMinute`      | number | `3`     | A user's posts in any minute past this many get `429`, before any challenge (0: no limit).                                                                                                                                       |
| `REPORTS_PER_HOUR`              | `reportsPerHour`              | number | `20`    | Posts and comments one user can report in an hour (0: no limit).                                                                                                                                                                 |
| `COMMENTS_PER_MINUTE`           | `comments.perMinute`          | number | `10`    | A user's comments in any minute past this many, on any posts, get `429`, before any challenge (0: no limit). Edits of comments count as comments.                                                                                |
| `INBOX_MESSAGES_PER_MINUTE`     | `inbox.messagesPerMinute`     | number | `10`    | Messages one user can send other users in a minute (0: no limit).                                                                                                                                                                |
| `MAX_FOLLOWING`                 | `maxFollowing`                | number | `1000`  | The most users one user can follow. A following feed reads the index of every one of them.                                                                                                                                       |




### Comments and inbox


| Variable               | File key              | Format | Default | What it does                                                                                                             |
| ---------------------- | --------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `COMMENTS_HOT_HOURS`   | `comments.hotHours`   | number | `24`    | How long Redis keeps a post's index of its comments, and each comment, before they're read from the content store again. |
| `INBOX_RETENTION_DAYS` | `inbox.retentionDays` | number | `90`    | Days a message or notice stays in an inbox, read or not. The compactor deletes older ones once a day.                    |




### Trust score

The [trust score](API.md#moderation) of a post or comment runs from 0 to 100. The first two numbers decide where it goes, and the third setting says which optional [trust plugins](TRUST_PLUGINS.md#optional-plugins) take part in working it out.


| Variable                   | File key                | Format | Default | What it does                                                                                                                                                                       |
| -------------------------- | ----------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_SCORE_DELETE_BELOW` | `trust.deleteBelow`     | number | `25`    | A post that scores less than this is refused (`422`) and nothing of it is kept. 0: no post is, so posts with a blocked word wait in the moderation queue instead.                  |
| `TRUST_SCORE_ALLOW_FROM`   | `trust.allowFrom`       | number | `75`    | A post that scores at least this is published. One that scores less, and isn't refused, waits in the moderation queue. 101: every post waits. At least `TRUST_SCORE_DELETE_BELOW`. |
| `TRUST_OPTIONAL_PLUGINS`   | `trust.optionalPlugins` | list   | empty   | The optional trust plugins the server runs, by the names of their folders in `src/plugins/trust`, separated by commas or spaces (a list of names in the file). The server comes with one, `urlhaus`. Empty: no optional plugin runs. Plugins that aren't optional, such as `blocked_words`, run whatever this says. A name that isn't a folder there stops the server from starting. |


### Links that spread malware

These are the settings of the `urlhaus` trust plugin, which refuses posts and comments with a link on [URLhaus](https://urlhaus.abuse.ch)'s list of malware URLs ([Trust plugins](TRUST_PLUGINS.md#links-that-spread-malware)). The plugin is optional: it runs only with `TRUST_OPTIONAL_PLUGINS=urlhaus`, and the settings aren't used otherwise.


| Variable                  | File key                 | Format | Default                                                           | What it does                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------ | ------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `URLHAUS_AUTH_KEY`        | `urlhaus.authKey`        | text   | unset                                                             | The Auth-Key the list is downloaded with: that of an abuse.ch account, which is free ([auth.abuse.ch](https://auth.abuse.ch)). Required when `TRUST_OPTIONAL_PLUGINS` names `urlhaus`: the server doesn't start without it. It's a credential, so on a deployment it belongs in `secrets`. |
| `URLHAUS_LIST_URL`        | `urlhaus.listUrl`        | URL    | `https://urlhaus-api.abuse.ch/v2/files/exports/{key}/recent.csv` | Where the list is downloaded from, with `{key}` where the Auth-Key goes: one of URLhaus's database dumps as a CSV, or its plain list of URLs. The default has the URLs added in the last 30 days. The server must be able to reach its host.                     |
| `URLHAUS_REFRESH_MINUTES` | `urlhaus.refreshMinutes` | number | `15`                                                              | Minutes between two downloads of the list, by each process. At least 5: URLhaus writes its lists every 5 minutes and asks not to be asked more often.                                                                                                          |




### Function settings

These are read by the function entry points (`[src/functions](../src/functions)`) only, and they're environment-only. The Terraform modules set them.


| Variable               | Format | Default        | What it does                                                                                                                                        |
| ---------------------- | ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUNCTION_GROUP`       | choice | none, required | Which route group this function is: `feed`, `content`, `store` or `api`. On AWS Lambda also `migrate`, the step a deploy runs first: it checks that the functions start with their settings, and then brings the database schema up to date. |
| `FUNCTION_EDGE_SECRET` | text   | unset          | A secret the CDN in front of the functions sends as `X-Origin-Secret`. Requests without it get `403`, except `/health`. Unset: no check.            |


A function also takes different defaults from a server where the variable isn't set: `DB_MIGRATE_ON_START=false`, `DB_POOL_SIZE=2`, `DB_IDLE_TIMEOUT_MS=10000` and `COMPACT_IN_PROCESS=false`.

### `BOOTSTRAP_ADMIN`

Read only by `npm run migrate` and the step a deployment of functions runs first (the migrate function on AWS, the migrate job elsewhere), for deployments that set up their [first admin](API.md#moderation) without a person at a command line. It's JSON, `{ "userId", "username", "keyHash" }`: an account's id and name, and the SHA-256 (in hex) of an API key made in the server's format, `tu_<12 hex characters>_<43 base64url characters>`. After the migrations, that account is created if it doesn't exist, made an admin, and, if the key is new to it, given that key as its only one. Running it again with the same value changes nothing, and with another key replaces the one the account has. A key the account had and replaced since (`[POST /users/:userId/key](API.md#post-usersuseridkey)`) stays revoked. The key itself never reaches the server. The [Terraform modules](DEPLOY.md#the-admin-account) set it, so you won't set it there yourself.

```sh
BOOTSTRAP_ADMIN='{"userId":"<a UUID>","username":"admin","keyHash":"<64 hex>"}' npm run migrate
```



### Changes that aren't environment variables

Two kinds of change are made in files, and are part of the image or the build, so deploying one is deploying new code. [Deploying a change](#b-deploying-a-change) says when each way needs a rebuild:

- **Languages:** the files of `[languages](../languages)` ([Languages](LANGUAGES.md)).
- **Trust plugins:** the folders of `src/plugins/trust` ([Trust plugins](TRUST_PLUGINS.md)). Turning an optional plugin that's already there on or off isn't one of these: that's `TRUST_OPTIONAL_PLUGINS`, an environment variable like any other.

The Terraform modules also have variables of their own, for the infrastructure rather than the server: memory and CPU, database and Redis sizes, how many instances, and the admin account. `variables.tf` in each module ([AWS](../deploy/terraform/aws/variables.tf), [Google Cloud](../deploy/terraform/gcp/variables.tf), [Azure](../deploy/terraform/azure/variables.tf)) lists them, and [DEPLOY.md](DEPLOY.md) explains them.

## B. Deploying a change

Change the setting where it's kept (a `.env` file, a compose file or `terraform.tfvars`), then put it into effect the way your instance runs. [Local](#local) is for an instance on your own machine or servers, and [Cloud](#cloud) is for one on AWS, Google Cloud or Azure.

Whichever you use, a setting is read by each process on its own, so **every process that reads it needs the new value**: the API nodes or functions, and the compactor. The Terraform modules and the compose files give them all the same settings. Where you run them yourself, change them all.

A change to a **language or a plugin** is a change to the code: it needs a rebuild (`npm run build`, `docker compose up --build`, or a Terraform apply, which rebuilds on its own) as well as a restart. A change to a setting never needs a rebuild.

### Local



#### From source

```sh
npm run build                                   # only if you changed a language or a plugin
node --env-file=.env dist/server.js             # restart the server
node --env-file=.env dist/compact/main.js       # and the compactor, if you run it as its own process
```

With `npm run dev` there's nothing to build: stop it and start it again, which reads the changed `.env` (`tsx watch` restarts when source files change, not when the environment does). A bad value stops the server as it starts, with the name of the setting.

Where you turned `DB_MIGRATE_ON_START` off, run the migrations first: `node --env-file=.env dist/db/migrate.js`.

#### With Docker Compose

Put the change in the file the stack reads: the `environment:` of the service (or the `x-app-env` block, which the compactor shares with the API) in `[docker-compose.yml](../docker-compose.yml)`, `[docker-compose.server.yml](../docker-compose.server.yml)` or `[testbed/docker-compose.yml](../testbed/docker-compose.yml)`, or the shell or `.env` variable that file reads, such as `CORS_ORIGINS`, `TAGGING_MODE` and `TAGGING_SERVER_TAGS` in `docker-compose.server.yml`. Then have Compose recreate the containers whose settings changed. Their data volumes stay:

```sh
docker compose -f docker-compose.server.yml up -d
docker compose -f testbed/docker-compose.yml up -d
docker compose --profile app up -d
```

Add `--build` if you also changed a language or a plugin.

#### On servers you run yourself

Where the server and the compactor run as services of your own (systemd units, supervisor, a process manager), change the environment they start with (the unit's `Environment=` or `EnvironmentFile=`, or the `.env` file their command loads), then restart them. With systemd:

```sh
sudo systemctl daemon-reload                  # only if you edited the unit file itself
sudo systemctl restart evieverse evieverse-compactor
```

The unit names are whatever you gave them. With several API nodes, restart them one at a time if you want no gap in service. Keep the compactor to one copy: stop the old one before starting the new, or rely on [its lease](DEPLOY.md#compactor), which makes a second copy's passes wait.

### Cloud



#### With the Terraform modules

Settings go in the module's `environment` variable, and credentials in `secrets` ([DEPLOY.md](DEPLOY.md#deploy)). Both are maps of strings, written [as shown above](#how-to-write-a-value), in `terraform.tfvars` (which is git-ignored, and which Terraform reads without being told):

```hcl
# deploy/terraform/<cloud>/terraform.tfvars
environment = {
  TAGGING_MODE        = "server"
  TAGGING_SERVER_TAGS = "news,local"
  CORS_ORIGINS        = "https://app.example.com"
}
```

Then deploy it, from the module's directory, with the same `-var` flags you first applied with (or put those in `terraform.tfvars` too, and leave them out here):

```sh
# AWS
cd deploy/terraform/aws
terraform plan  -var region=us-east-1
terraform apply -var region=us-east-1

# Google Cloud
cd deploy/terraform/gcp
terraform plan  -var project_id=my-project -var region=us-central1
terraform apply -var project_id=my-project -var region=us-central1

# Azure
cd deploy/terraform/azure
terraform plan  -var subscription_id=00000000-0000-0000-0000-000000000000 -var location=eastus
terraform apply -var subscription_id=00000000-0000-0000-0000-000000000000 -var location=eastus
```

`terraform plan` shows what the apply would change without changing it. For a setting, it should list only the functions and the compactor. To apply exactly the plan you read, in a pipeline or after a review, save it:

```sh
terraform plan -out=settings.tfplan [the same -var flags]
terraform apply settings.tfplan
```

The first time in a checkout, run `terraform init` too. The apply prints `url` again at the end, and `terraform output url` shows it later.

What the apply does depends on what you changed:


| You changed                                   | The apply                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment` or `secrets`                    | Checks the new settings, and only then updates every function and the compactor with them. If the server refuses one, the apply stops there with the old settings still in use ([below](#when-a-setting-is-refused)). It doesn't rebuild the image, and the migrations have nothing to do. Running instances are replaced by ones with the new settings: a new Lambda configuration, a new Cloud Run revision, a new Container Apps revision. The compactor stops, finishing its pass where it can, and starts again, so there's a moment with none, which the next pass makes up. |
| A language, a plugin, or any file under `src` | Rebuilds the image and pushes it, checks the settings with the new image and runs the migrations, and only then updates the functions and the compactor. If either fails, the apply stops there with the old functions still serving.                                                                                                                                                                                                  |
| `image`                                       | The same, with the image you name instead of one it builds.                                                                                                                                                                                                                                                                                                                                                                             |


#### When a setting is refused

Updating a function doesn't start it, so a setting the server refuses wouldn't show until requests failed. The apply checks first instead. Before it updates anything, it runs one step (the migrate function on AWS, the migrate job on GCP and Azure) with the settings the functions are about to get, which starts each route group as its function would. If the server doesn't start with them, the step fails and the apply stops:

- **Nothing was changed.** The functions and the compactor keep the settings they had, and go on serving.
- **The step's log says which setting, and why,** for example "the functions would not start with these settings, so nothing was changed: TRUST_OPTIONAL_PLUGINS names urlhouse, which isn't a folder of…". The step is named after the deployment, `<name>-migrate`: on AWS its log group is `/aws/lambda/<name>-migrate`, and on GCP and Azure it's the job's log.
- **Fix the value and apply again.** The step runs again on every apply until it passes.

What the check catches is what stops the server from starting: a value in the wrong format, a name that isn't one (a plugin in `TRUST_OPTIONAL_PLUGINS`, a `CONTENT_SCHEME`, a `DEFAULT_LANGUAGE` with no file), and settings that need each other (`TAGGING_MODE=server` without `TAGGING_SERVER_TAGS`, `urlhaus` without `URLHAUS_AUTH_KEY`). The last of these fails sooner, in the plan. What it doesn't catch is a value the server starts with but that is wrong: a bucket that doesn't exist, or a key a service refuses, shows when it's used.

Things to know:

- **Some settings are set by the module, and** `environment` **replaces them.** The modules set `DB_DIALECT`, `CONTENT_SCHEME`, `CONTENT_OPTIONS`, `PUBLIC_BASE_URL`, `COMPACT_IN_PROCESS` and, per cloud, `STORAGE_TMP_PATH` and `MAX_UPLOAD_BYTES` ([the limits](DEPLOY.md#uploads)). A value in `environment` takes their place, and the apply checks only that the server starts with it, not that it suits the deployment: `DB_DIALECT=mysql`, against the PostgreSQL the module made, passes the check and breaks the instance.
- `**TRUST_PROXY` differs by cloud.** On GCP and Azure it follows the module's `trust_proxy` variable (2), and an `environment` value replaces that. On AWS it's fixed at `1` for the functions, and an `environment` value is ignored by them. Change it on GCP and Azure with the variable ([Client addresses](DEPLOY.md#client-addresses)).
- `**DB_POOL_SIZE` on GCP and Azure** is the module's `db_pool_size` variable, which an `environment` value overrides. Keep to the connection arithmetic in [Scaling and the database](DEPLOY.md#scaling-and-the-database).
- `**secrets` on AWS reach the functions and the compactor differently.** The functions get them in their configuration and update with the apply. The compactor reads them from Secrets Manager when its task starts, where they're written only once the settings check has passed. Its task definition doesn't change when only a secret's value does, so the running compactor keeps the old value. After such an apply, restart it. `terraform output compactor` names it:
  ```sh
  aws ecs update-service --cluster <name> --service <name>-compactor --force-new-deployment
  ```
- `**secrets` on GCP are read by version.** Each value in `secrets` is a version of a secret in Secret Manager, and the services, the compactor and the jobs read the version the apply wrote, by its number, not the latest. So a changed secret is a new revision, which waits for the settings check like any other change, and the version before it is deleted once the services read the new one.
- **Changing where data lives doesn't move it.** `CONTENT_SCHEME`, `CONTENT_OPTIONS`, `SUMMARY_SCHEME`, `SUMMARY_OPTIONS`, `AUDIT_SCHEME` and `AUDIT_OPTIONS` point the server at another store, which starts empty. Likewise, a new `REDIS_KEY_PREFIX` points it at an empty index, which the [rebuild](DEPLOY.md#redis) fills from the database and the content store.
- `**PUBLIC_BASE_URL` for a custom domain** goes in `environment` too ([Custom domains](DEPLOY.md#custom-domains)).
- **Leave** `BOOTSTRAP_ADMIN`**,** `FUNCTION_GROUP`**,** `FUNCTION_EDGE_SECRET`**,** `AUDIT_SCHEME` **and** `AUDIT_OPTIONS` **out of** `environment`**.** The modules set them, and the admin account has [variables of its own](DEPLOY.md#the-admin-account).
- **Keep** `terraform.tfvars` **and the state where only the people who deploy can read them.** The secrets are in the state in plain text.

To check a change took effect, ask the instance. `curl "$(terraform output -raw url)/health"` says it's up, and a setting with a visible effect shows itself: `GET /tagging` lists the hashtags in server mode, and a browser request from an origin shows whether `CORS_ORIGINS` allows it. For one that doesn't, the function's or compactor's log shows the settings it started with. `terraform output compactor` names the compactor, and its log group on AWS.

#### Without the Terraform modules

Where you built the cloud setup yourself ([Setting it up yourself](DEPLOY.md#setting-it-up-yourself)), change the settings where your platform keeps them, so that each API node, function and the compactor starts with them. Most platforms start new instances for a changed setting and retire the old, and the commands below do that:


| Platform                        | What to change                                       | How                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS ECS** (API, compactor)    | The container's `environment` in the task definition | Register a new revision, then `aws ecs update-service --cluster <cluster> --service <service> --task-definition <family> --force-new-deployment`                                                  |
| **AWS Lambda**                  | The function's configuration                         | `aws lambda update-function-configuration --function-name <name> --environment 'Variables={KEY=value,...}'`. This replaces all the function's variables, so list every one, not only the changed. |
| **Google Cloud Run** (services) | The service's environment variables                  | `gcloud run services update <service> --region <region> --update-env-vars KEY=value`. It starts a new revision. Update a worker pool's environment too, if the compactor runs in one.             |
| **Azure Container Apps**        | The app's environment variables                      | `az containerapp update --name <app> --resource-group <group> --set-env-vars KEY=value`. A secret is `KEY=secretref:<secret>`, set first with `az containerapp secret set`.                       |
| **Kubernetes** (GKE, AKS, EKS)  | The ConfigMap or Secret the pods read                | `kubectl apply -f <file>`, then `kubectl rollout restart deployment/<name>`. Pods don't take a changed ConfigMap into their environment until they restart.                                       |


A function isn't started by updating it, so a setting the server refuses shows only when requests fail. Check the settings first, as the modules do: run `node dist/functions/migrate.js` (on Lambda, the function whose `FUNCTION_GROUP` is `migrate`) with the settings the functions are about to get, and update them only if it succeeds ([Setting it up yourself](DEPLOY.md#setting-it-up-yourself)).

Keep the compactor to one copy while you do it. Where the platform starts the new one before it stops the old (Cloud Run and Container Apps can), the two overlap for a moment, and [the compactor's lease](DEPLOY.md#compactor) makes a second copy's passes wait, so nothing is corrupted. On ECS, set `deployment_minimum_healthy_percent` to 0 and `deployment_maximum_percent` to 100, as the module does, so the old task stops first.