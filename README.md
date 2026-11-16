# Evieverse: An Open Source Serverless Social Media Framework

## Mission

Provide an open source alternative to traditional social media that allows for:

1. Full user control over how content is delivered.
2. Syndicated publishing to multiple instances of Evieverse.
3. A pay-as-you-go architecture that scales effortlessly.
4. Effortless infrastructure-as-code cloud deployment and setup.
5. Seamless integration into existing clients.

| To | Read |
| --- | --- |
| Build a client, or call the API | [API.md](API.md) |
| Administer or moderate an instance | [CLI.md](CLI.md) |
| Deploy an instance to AWS, Google Cloud or Azure | [deploy/README.md](deploy/README.md) |
| Understand how it works inside | [APP.md](APP.md) |


## Getting started

These steps put an instance in your cloud account and sign you in as its admin. To try one on your own machine first, see [On your own machine](#on-your-own-machine).

You need Terraform 1.5 or newer, your cloud's CLI signed in, Docker (for AWS and Google Cloud), and Node.js 20 or newer for the Evieverse CLI.

### 1. Deploy

```sh
cd deploy/terraform/aws        # or gcp, or azure
terraform init
terraform apply                # gcp: add -var project_id=<project>    azure: add -var subscription_id=<subscription>
```

The apply builds the server, provisions everything it runs on, and prints the instance's HTTPS address as `url`. It also creates the instance's first admin account, and saves that account's API key on your machine, where the CLI reads it. [deploy/README.md](deploy/README.md) covers the variables, what each cloud provisions and what it costs.

### 2. Install the CLI

Every instance ships its own CLI, `evieverse`:

```sh
URL="$(terraform output -raw url)"
curl -fsSL "$URL/cli/install.sh" | sh       # Windows, in PowerShell: irm <url>/cli/install.ps1 | iex
evieverse whoami
```

```
admin (10e57144-…) on https://d1234abcd.cloudfront.net: an admin
```

The script says how to add `evieverse` to your `PATH` if it isn't there. `evieverse help` lists what it can do, such as appointing moderators, blocking words and working through the moderation queues, and [CLI.md](CLI.md) is its reference.

### 3. Create another user

The admin account the deployment made is for emergencies, so give yourself an account of your own.

Accounts are created by registering with the instance. To keep bots out, registering takes a challenge that a person solves, but not when an admin registers the user. So register your account as the deployment's admin, whose id and key are outputs of the deployment. The CLI has no command for it, so it's one request to the API, from the Terraform directory:

```sh
curl -s -X POST "$URL/register" -H 'Content-Type: application/json' \
  -H "X-User-Id: $(terraform output -raw admin_user_id)" \
  -H "Authorization: Bearer $(terraform output -raw admin_api_key)" \
  -d '{"username":"alice"}'
```

```json
{ "userId": "56243052-…", "username": "alice", "language": "en", "apiKey": "tu_cba15064d3f1_…", "note": "Store this apiKey now; it cannot be retrieved again." }
```

The `userId` and `apiKey` are the new account's, not the admin's. Keep the `apiKey`: it's shown this once. An instance takes 10 registration requests an hour from one address by default, an admin's included.

To make the new account an admin, and sign the CLI in as it:

```sh
evieverse admins grant <userId>                         # as the deployment's admin
evieverse --profile alice login "$URL" <userId>         # asks for the API key, and saves it as the profile "alice"
evieverse --profile alice whoami
```

The machine now has two profiles, so each command names the one it's for: `--profile alice` for your account, and `--profile evieverse` for the deployment's admin.

## Evieverse clients

Apart from its admin CLI, an instance has no client of its own. It's designed for clients, such as single-page apps, that each work with several instances at once. A client should:

1. **Register the user on several instances,** and give them one interface to all of them.
2. **Keep one set of credentials** that unlocks the user's API key for each instance, so the client is the layer between the user and the instances they've registered on.
3. **Let the user set the parameters of each request,** such as a feed's tags, window and algorithm, so the experience is theirs to shape.
4. **Syndicate a post to several instances** by posting it to each one. Instances don't pass posts on to each other, so a user's key for one instance never goes to another.

## Bring your own client

Every instance serves the same API, so anyone can register on an instance directly, keep their own key, and use whatever client they like, including one they wrote. [API.md](API.md) is the contract: every endpoint, what it takes and what it returns.

## User registration and API keys

A user registers by asking an instance for an account under a username (`POST /register`). The instance answers with a challenge that tells people from bots: an image of six characters for the user to read, and a proof of work for the client's software to do meanwhile. The client shows the user the image, and sends their answer back.

Once the challenge is solved, the instance returns the user's id and an API key. The two go with every request that changes something. Reading feeds, posts and profiles needs no account.

The key is shown once, and an instance has no way to show it again, so it's the client's job to keep it safe. A user who still has their key can replace it (`POST /users/:userId/key`, or `evieverse key rotate`): the old key stops working at once and a new one comes back, which is what to do when a key may have leaked. A key that's lost can't be replaced. The details are in [API.md](API.md#post-usersuseridkey).

**Admins register users without a challenge.** An admin who sends their own id and key with the request (`X-User-Id` and `Authorization: Bearer <apiKey>`) gets the account at once, as [Getting started](#3-create-another-user) does. The id and key that come back are the new user's, for the admin to pass on. Only an admin's key does this: any other user's request gets the challenge, and a wrong key is refused. The details are in [API.md](API.md#post-register).

**Without a client,** anyone can register from a terminal. It's two requests to the API (with `curl`, `jq` and `node`), where `$URL` is the instance's address:

```sh
# Ask for the account. The server answers with a challenge, which holds an image of six characters.
curl -s -X POST "$URL/register" -H 'Content-Type: application/json' -d '{"username":"alice"}' > challenge.json
jq -r .challenge.image challenge.json | cut -d, -f2 | base64 --decode > challenge.png
open challenge.png             # Linux: xdg-open challenge.png

# Within two minutes, ask again with the characters you read (here ABC123) and a proof of work, which node finds.
node -e '
  const { createHash } = require("node:crypto");
  const { id, proofOfWork: { prefix, bits } } = require("./challenge.json").challenge;
  let nonce = 0;
  while (Math.clz32(createHash("sha256").update(prefix + nonce).digest().readUInt32BE(0)) < bits) nonce++;
  console.log(JSON.stringify({ username: "alice", challengeId: id, challengeAnswer: process.argv[1], challengeNonce: String(nonce) }));
' ABC123 | curl -s -X POST "$URL/register" -H 'Content-Type: application/json' -d @-
```

If the characters were wrong, the answer is a new challenge instead, so run both requests again. An instance takes 10 registration requests an hour from one address by default.

## Content organization and moderation

As on most social media, content is organized by tags (hashtags). An instance is deployed in one of two tagging modes:

- **User-supplied tags** (the default): a post carries the tags its publisher gives it, up to 10.
- **Server-enforced tags:** the instance's operator sets the tags, and every post gets them. Tags a publisher sends are ignored.

A post with no valid tags is rejected.

**Auto-moderation.** Every new post and update gets a trust score when it arrives. Depending on the score, the post is published, held in the moderation queue until someone accepts or rejects it, or rejected outright. Out of the box, the score comes from one check, the instance's list of blocked words: a post containing one is rejected, and every other post is published. Posts are held only once the instance changes its thresholds or adds a check of its own, as a [trust plugin](#trust-plugins).

**Moderators.** Three roles decide what's published:

- **Admins** can delete any post or comment, accept or reject held posts and comments, keep the instance's blocked words, and appoint the other two roles. They also [register users without a challenge](#user-registration-and-api-keys).
- **Server moderators** accept or reject the posts and comments held in the moderation queue, and accept or delete the posts and comments users reported.
- **Tag moderators** look after one or more tags. Under their tag, they can approve a post or remove the tag from it, block words, and mute a user, whose later posts then don't get the tag. They have no say over comments.

A post is published under its tags before any tag moderator has seen it. Feeds say which posts a tag's moderators have approved, and can be asked for only those.

**Reports.** Any user can report a published post, or a comment on one, with a reason if they have one. Reported posts and comments stay published and wait in the report queue, where a server moderator or an admin accepts each, which leaves it as it is, or deletes it.

If removing a tag would leave a post with no tags, the post itself is removed.

The rules are in [API.md](API.md#moderation), and admins and moderators do all of it with the [CLI](CLI.md).

## Posts

A post is one of five types:

- an image, a video or an audio file, each with an optional caption;
- text, of up to 40,000 characters;
- a link, which is also how any other kind of file, such as a PDF, is shared.

With each post, its publisher declares whether it was created with AI, and readers can filter feeds on that. The declaration is the publisher's word: nothing checks it.

A publisher can update a post, which replaces it and keeps no history, and delete it. Every post is credited to its publisher's username.

To keep bots from flooding an instance, a user who posts again within a minute first solves a challenge, and more of them the longer they keep posting. By default nobody posts more than 3 times a minute.

## Comments

A post takes comments if its publisher turns them on, which they do post by post, and can change later. They're off unless the publisher says.

- A comment is text, of up to 2,000 characters. Comments are flat: there are no replies to a comment. A comment can be deleted, but not edited.
- Anyone can read a post's comments, oldest or newest first, and any user can add one, up to 10 a minute by default.
- **Comments are moderated as posts are.** Each gets a trust score from the same checks, and by the same thresholds is published, held in the moderation queue or rejected outright. Held comments wait in the same queue as held posts, for a server moderator or an admin.
- **Comments can be reported,** and then wait in the same report queue as reported posts.
- A comment can be deleted by its author, by the publisher of the post it's on, and by an admin.
- Turning comments off on a post closes and hides them without deleting them. Deleting the post deletes them.

The details are in [API.md](API.md#comments).

## Likes

A user can like any post, once, and a like can't be taken back. A post's likes are shown wherever the post is, in feeds and on the post itself, and they're what the `popular` feed algorithm orders posts by.

## Following

A user can follow any other user, up to 1,000 of them by default, and read a feed of everything those users post, newest first. Whom a user follows, and who follows them, is public.

## Inbox

Every user has an inbox, which only they can read. Two things arrive in it:

- **Notices.** When a moderator or an admin removes a tag from a user's post, accepts or rejects it in the moderation queue, deletes it, or mutes the user under a tag, the user is told, in their own language. So is the author of a comment that is accepted or rejected in the moderation queue, or that someone else deletes. A notice doesn't say who it was.
- **Messages from other users.** A user can turn these off, and is then sent none and sends none. A user can also block other users: no message goes between the two, and the blocked user isn't told.

By default a user sends at most 10 messages a minute, and an inbox keeps what arrives for 90 days. The details are in [API.md](API.md#inbox).

## Feed

A feed is what the reader asks for. The reader chooses:

- **Tags:** one or more, and optionally the tags related to them, which are the ones that tend to appear on the same posts.
- **A window:** from the past hour to the past 90 days.
- **An algorithm:**
  - `popular` (the default) returns each day's most liked posts first. The last 24 hours get half the page, the 24 hours before them a quarter, and so on. The tags asked for take turns, and some places among the newest posts go to posts nobody has liked yet, so that new posts get seen.
  - `chronological` returns the newest posts first.
- **Filters:** only content declared as created with AI, or only content that wasn't. Only posts a tag's moderators have approved, or only posts they haven't.

A second kind of feed returns the posts of the users someone follows, newest first.

Feeds come a page at a time, 50 posts by default. Reading one needs no account, and nothing about the reader goes into it: the same request is answered by the same rules for everyone. The rules are spelled out in [API.md](API.md#get-feed), and [APP.md](APP.md#9-how-a-feed-is-built) explains how the server carries them out.

## Running an instance

### In the cloud

Ready-made Terraform for AWS, Google Cloud and Azure is in [`deploy/`](deploy/README.md), and [Getting started](#getting-started) uses it. The modules run the server as functions: one per group of routes (feed, content, store, and the rest), each scaling with its own traffic, behind one address. One container that's always running, the compactor, sits beside them.

[deploy/README.md](deploy/README.md) also lists which of each cloud's services to use if you set it up yourself, and [APP.md](APP.md#13-deployment-topology) has the rules that apply on every cloud.

### On your own machine

Requires Node 22+.

```bash
npm install
npm run dev            # SQLite in ./data, content and summaries in ./data/content, the index in memory
```

The server listens on `http://localhost:3000`. Other ways to run it:

| To run | Command |
| --- | --- |
| The testbed: an instance seeded with users and posts, and a web page for reading feeds, posting and registering, at `http://localhost:8080` | `docker compose -f testbed/docker-compose.yml up -d --build` |
| Just the API in Docker, for building a client against, at `http://localhost:3000` (Postgres, Valkey, and content on a local volume) | `docker compose -f docker-compose.server.yml up -d --build` |
| The full stack in Docker (Postgres, an S3-compatible store for content and summaries, Valkey for the index, and a separate compactor) | `docker compose --profile app up --build` |

Things to know:

- **Registering.** `CHALLENGE_REGISTER=false npm run dev` turns the registration challenge off for everyone, so one request creates an account: `curl -X POST localhost:3000/register -H 'Content-Type: application/json' -d '{"username":"alice"}'`. With it on, only [an admin's request](#user-registration-and-api-keys) skips it.
- **The CLI.** A server run from source ships no CLI. `npm run build && npm start` builds and ships it, and `curl -fsSL http://localhost:3000/cli/install.sh | sh` then installs it.
- **Redis.** Without `REDIS_URL`, the feed index lives inside the process, and the server rebuilds it from the database and the content store each time it starts. To keep it across restarts, point `REDIS_URL` at a local Redis or Valkey (`docker compose up -d redis`, then `REDIS_URL=redis://127.0.0.1:6379`).
- **Browsers.** The API in Docker (`docker-compose.server.yml`) accepts browser requests from any origin. Set `CORS_ORIGINS` (e.g. `CORS_ORIGINS=http://localhost:5173`) to allow only your frontend's.

### What it runs on

The design rests on one rule: **the feed never touches the database, and almost never leaves RAM**. Feeds are planned from a small index of each tag in Redis, and a background process, the compactor, keeps that index up to date. [APP.md](APP.md) explains all of it.

- **Database:** SQLite, Postgres or MySQL. It holds users, API keys, a row per post, likes, follows, inboxes and blocks, and the moderation rules and queue. Comments aren't in it, except for a row for each one that's held or reported. The schema is portable SQL in [`src/db/migrations`](src/db/migrations), applied on start or with `npm run migrate`.
- **Content store:** any [Apache OpenDAL](https://opendal.apache.org) backend: local disk, S3 or anything S3-compatible, GCS, Azure Blob, SFTP, WebDAV, and more. It holds each post's bytes and summary, and each comment.
- **Redis:** any Redis-protocol server with a single primary (Redis 6.2 or later, Valkey, ElastiCache, Memorystore, Azure Managed Redis), set with `REDIS_URL`. It holds the feed index, the summaries of the last 8 days and the comments of the last day, and nearly all of it can be rebuilt from the other two. Without `REDIS_URL`, an in-process store stands in, which only suits a single node.
- **The compactor:** one process that's always running, and merges new posts and likes into the index every 5 seconds by default. It runs inside the server, or on its own with `npm run compact`.

### The first admin

Making an admin takes an admin, so the first one comes from whoever runs the instance:

- The [Terraform modules](deploy/README.md#the-admin-account) create an admin account with every deployment, and put its API key on the machine that applies.
- Anywhere else, the operator makes one from the command line, with the server's configuration:

  ```bash
  npm run build
  npm run admin -- grant alice      # a username or a userId
  npm run admin -- revoke alice
  npm run admin -- list
  ```

  In the Docker image, that's `node dist/moderation/admin.js grant alice` (with the testbed, `docker compose -f testbed/docker-compose.yml exec app node dist/moderation/admin.js grant alice`). Like the server, it applies the database migrations first. It writes to the database directly, so it also works when no admin's key is at hand.

From then on, admins make more with the CLI (`evieverse admins grant <userId>`).

### Configuration

Every setting is an environment variable. [`.env.example`](.env.example) lists them all, each with its default and what it does: copy it to `.env` and change what you need.

- The server doesn't read `.env` files itself. Load one with `node --env-file=.env dist/server.js`, Docker Compose's `env_file:`, or your platform's settings.
- Settings can also come from a JSON file of nested keys, named by `EVIEVERSE_CONFIG` (`evieverse.config.json` by default). Its keys are in [`src/config.ts`](src/config.ts).
- Environment variables take precedence over the file, and an empty variable counts as unset.

One more variable, `BOOTSTRAP_ADMIN`, is read only by `npm run migrate` (and the migrate function), for deployments that set up their [first admin](#the-first-admin) without a person at a command line. It's JSON, `{ "userId", "username", "keyHash" }`: an account's id and name, and the SHA-256 (in hex) of an API key made in the server's format, `tu_<12 hex characters>_<43 base64url characters>`. After the migrations, that account is created if it doesn't exist, made an admin, and given that key as its only one. Running it again with the same value changes nothing, and with another key replaces the old one. The key itself never reaches the server. The [Terraform modules](deploy/README.md#the-admin-account) do this.

### Languages

What the server says to its users, which is its errors and the notes that come with some results, is in the language files of [`src/languages`](src/languages): one file per language, named after the language's code. The server comes with English, `en.json`. Posts aren't translated.

To add a language, copy `en.json` to a file named after the new language's code (`es.json`, `pt-BR.json`), change `name` to the language's own name and translate the messages, then build and restart the server:

```json
{ "name": "Español",
  "messages": {
    "user.username_taken": "el nombre de usuario ya está en uso",
    "follow.limit": "puedes seguir como máximo a {max} usuarios",
    "upload.rate_limited": { "one": "demasiados archivos; inténtalo de nuevo en {count} segundo",
                             "other": "demasiados archivos; inténtalo de nuevo en {count} segundos" } } }
```

- Keep the keys and the `{placeholders}` as they are, and translate the words around them.
- A message with forms (`one`, `other`) depends on a number. Give it the forms the language has, of `zero`, `one`, `two`, `few`, `many` and `other`; `other` is required.
- A translation can be partial. A message the file lacks is said in the default language, and the server logs which ones those are when it starts.
- `DEFAULT_LANGUAGE` (`en`) is the language of anyone who hasn't chosen one. The server doesn't start if that language has no file, or if a file in the folder isn't a language.

Users pick any of the server's languages when they register and can change it later, and `GET /languages` lists them ([API.md](API.md#languages)).

### Trust plugins

A trust plugin is an algorithm that looks at a post and may lower its trust score, which [decides where the post goes](API.md#moderation). Each folder of `src/plugins/trust` is one plugin, named after the folder, and every new post, update and comment goes through all of them. The server comes with `src/plugins/trust/blocked_words`.

To add one, add a folder with an `index.ts` whose default export has an `assess` function, and build and restart the server:

```ts
// src/plugins/trust/links/index.ts
import type { TrustAlgorithm } from '../../../moderation/trust.js';

export default {
  assess({ texts }) {
    const links = texts.join(' ').match(/https?:\/\//g)?.length ?? 0;
    if (links > 3) return { reduce: 40, reason: "the post has too many links, so it wasn't published" };
  },
} satisfies TrustAlgorithm;
```

- `assess(post, ctx)` gets the post (`userId`, `tags`, `texts`, which are its text, caption or link and its filename, and `contentId` if it's an update) and a context (`db`, `config`, `now`, and `score`, the score so far). It can be async.
- **Comments go through the same plugins.** For a comment, `commentOn` is the id of the post it's on, `userId` is its author, `texts` holds its text, and `tags` is empty. A plugin that leaves `commentOn` alone treats comments as it treats posts; one that should only look at posts returns nothing when `commentOn` is set. The example above would tell a commenter that "the post" has too many links, so a plugin that words a `reason` can go by `commentOn` there too.
- It returns `{ set: <score> }` or `{ reduce: <points> }`, or nothing to leave the score alone.
- **The score only goes down.** A plugin that sets a score higher than the current one changes nothing, so where plugins disagree, the lower score wins. A reduction always applies. The score never goes below 0 and is kept as a whole number, rounded down.
- Plugins run one after another in the order of their folder names, and all of them run, whatever the score. The order only matters when sets and reductions mix: set to 50 and then reduce by 20 gives 30, the other way round gives 50.
- `reason` is optional. If the post is refused, the publisher gets the reason of the plugin that last lowered the score, or a general message if it gave none. Words written here are sent as they are, in every language. To have a reason translated, add it to the [language files](#languages) and return its key instead: `reason: msg('moderation.blocked_word')`, with `msg` from `src/language.ts`.
- A folder without a plugin in it stops the server from starting. A plugin that throws fails the post with `500`, and nothing is stored: no post is published without every plugin having looked at it.

Plugins are part of the server: they run with its access to the database and its configuration, so install only code you'd run as the server itself.

## Development

```bash
npm test     # unit tests, migration tests, API and feed-index tests on SQLite with the in-process store
docker compose up -d postgres mysql redis
TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

Each test against Redis uses its own key prefix and deletes its keys afterwards, so any Redis or Valkey will do. Tests against Postgres or MySQL recreate the database's tables, so give them a database of their own, and add `--no-file-parallelism` to run the test files one at a time.

What the server doesn't do, or doesn't do yet, is listed in [APP.md](APP.md#14-known-limits).

## License

MIT.
