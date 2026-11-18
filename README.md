# Evieverse: An Open Source Social Media Framework

## Mission

Provide an open source alternative to traditional social media that allows for:

1. Transparent content delivery while delivering engaging content.
2. AI usage disclosure for content and the ability to filter-out content with declared AI usage.
3. Ability to use many different clients on the same server, including a client you build yourself.
4. Optional privacy for user follows and followers.
5. Monetization options.
6. Built-in robot detection and rate limiting.
7. Plugin-based content trust analysis for auto-moderation.
8. Support for multiple languages (English is default)
9. Low-cost self-hosting: a whole instance runs in one Docker container, on a laptop or a small server.
10. Pay-as-you-go architecture that scales effortlessly.
11. Easy infrastructure-as-code cloud deployment, setup, database migrations, and updates.

Evieverse is designed with the idea that clients will enable users to connect to multiple different Evieverse instances. Content is not federated from server-to-server, but from client to servers they have subscribed to. 


| To                                               | Read                                           |
| ------------------------------------------------ | ---------------------------------------------- |
| Run an instance in Docker, or from source        | [Getting started](#getting-started)            |
| Put a Docker instance on the internet            | [Deploy with Docker](#deploying-with-docker)   |
| Deploy an instance to AWS, Google Cloud or Azure | [docs/DEPLOY.md](docs/DEPLOY.md)               |
| Configure an instance, and deploy a change       | [docs/CONFIG.md](docs/CONFIG.md)               |
| Administer or moderate an instance               | [docs/CLI.md](docs/CLI.md)                     |
| Build a client, or call the API                  | [docs/API.md](docs/API.md)                     |
| Write or show formatted posts and comments       | [docs/TEXT_EDITORS.md](docs/TEXT_EDITORS.md)   |
| Add a language the server answers in             | [docs/LANGUAGES.md](docs/LANGUAGES.md)         |
| Write a trust plugin, to score posts             | [docs/TRUST_PLUGINS.md](docs/TRUST_PLUGINS.md) |
| Understand how it works inside                   | [docs/APP.md](docs/APP.md)                     |




## Getting started

An instance runs in one of three ways. It's the same server and the same API in each:

| Way             | What runs                                                                              | You need                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Docker**      | One container, on your own machine or a small server, with the whole instance in it    | Docker                                                                                    |
| **From source** | One Node.js process                                                                    | Node.js 22 or newer, and ffmpeg                                                           |
| **Cloud**       | Functions and managed services on AWS, Google Cloud or Azure, which scale with traffic | Terraform 1.5 or newer, your cloud's CLI signed in, and Docker (for AWS and Google Cloud) |

Each also needs Node.js 20 or newer on your machine, for the Evieverse CLI.

### 1. Start an instance

**In Docker.** From a clone of this repository:

```sh
docker build -t evieverse .
docker run -d --name evieverse --restart unless-stopped -p 3000:3000 -v evieverse:/app/data evieverse
curl http://localhost:3000/health         # {"ok":true}
```

That one container is a whole instance, at `http://localhost:3000`. Its database (SQLite) and its posts' files are on the `evieverse` volume, and its feed index is in memory, rebuilt on each start. [Deploying with Docker](#deploying-with-docker) has what to add to put it on the internet.

**From source.** With ffmpeg installed (`brew install ffmpeg`, `apt install ffmpeg`), or with `VIDEO_PROCESSING=false`, which stores videos as they're sent:

```sh
npm install
npm run build
npm start                  # the same instance, with its data in ./data
```

**In the cloud.**

```sh
cd deploy/terraform/aws        # or gcp, or azure
terraform init
terraform apply                # gcp: add -var project_id=<project>    azure: add -var subscription_id=<subscription>
```

The apply builds the server and prints the instance's HTTPS address as `url`. It also creates the instance's first admin account and saves that account's API key on your machine for use by the CLI, so step 2 is done. See [DEPLOY.md](docs/DEPLOY.md)

### 2. Create the first admin

In Docker and from source, you make the admin's id and API key yourself, and give the server the key's hash:

```sh
USER_ID="$(node -p 'crypto.randomUUID()')"
KEY="ev_$(node -p 'crypto.randomBytes(6).toString("hex") + "_" + crypto.randomBytes(32).toString("base64url")')"
HASH="$(node -p 'crypto.createHash("sha256").update(process.argv[1]).digest("hex")' "$KEY")"
ADMIN="{\"userId\":\"$USER_ID\",\"username\":\"admin\",\"keyHash\":\"$HASH\"}"

docker exec -e BOOTSTRAP_ADMIN="$ADMIN" evieverse node dist/db/migrate.js     # from source: BOOTSTRAP_ADMIN="$ADMIN" npm run migrate
```

```
Migrations complete (sqlite).
Admin account admin (10e57144-…) created.
```

`$KEY` is the admin's API key. The server keeps only its hash, so the key exists nowhere else until step 3 saves it. See [CONFIG.md](docs/CONFIG.md#bootstrap_admin).

### 3. Install the CLI

Every instance ships its own CLI, `evieverse`:

```sh
URL=http://localhost:3000                   # cloud: URL="$(terraform output -raw url)"
curl -fsSL "$URL/cli/install.sh" | sh       # Windows, in PowerShell: irm <url>/cli/install.ps1 | iex
EVIEVERSE_API_KEY="$KEY" evieverse --profile evieverse login "$URL" "$USER_ID"     # skip in the cloud: the apply saved this profile
evieverse whoami
```

```
admin (10e57144-…) on http://localhost:3000: an admin
```

The script says how to add `evieverse` to your `PATH` if it isn't there. `evieverse help` lists what it can do, and [CLI.md](docs/CLI.md) is its reference.

### 4. Create another user

Registering requires solving a challenge unless it's an admin account registering the user. To register another account:

```sh
evieverse register <username>  #e.g. evelynn
```

```
Registered evelynn (56243052-…).
Their API key, shown this once: ev_cba15064d3f1_…
```

To make the new account an admin:

```sh
evieverse admins grant <userId>                         # as the deployment's admin
evieverse --profile alice login "$URL" <userId>         # asks for the API key, and saves it as the profile "alice"
evieverse --profile alice whoami
```

The machine now has two profiles: `--profile alice` for your account, and `--profile evieverse` for the deployment's admin.

## Deploying with Docker

One image runs every role of an instance ([`Dockerfile`](Dockerfile)), and has ffmpeg for videos. It isn't published to a registry, so build it from a clone. With no settings it's a whole instance in one container, and each piece moves out of that container with a setting ([CONFIG.md](docs/CONFIG.md)):

| Piece                                  | With no settings                                                                                   | To change it                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database                               | SQLite, a file on the volume (`/app/data`)                                                         | `DB_DIALECT` and `DATABASE_URL`: Postgres or MySQL, in a container or anywhere else                                                                  |
| Feed index                             | In the server's memory, rebuilt from the database and the files on each start. One server only     | `REDIS_URL`: Valkey or Redis, not in cluster mode. The index then outlasts a restart                                                                 |
| Posts' files                           | Files on the volume (`/app/data/content`)                                                          | `CONTENT_SCHEME` and `CONTENT_OPTIONS`: an S3-compatible store ([Where the files go](#where-the-files-go))                                           |
| Compactor, which also processes videos | Inside the server                                                                                  | `COMPACT_IN_PROCESS=false`, and a second container with the same image, settings and volumes that runs `node dist/compact/main.js`. Needs `REDIS_URL` |
| HTTPS                                  | None: plain HTTP on port 3000                                                                      | A reverse proxy in front, with `PUBLIC_BASE_URL` and `TRUST_PROXY`                                                                                   |

### A server on the internet

What follows puts an instance on one server that a domain name points at: the server on Postgres and Valkey, posts' files on a volume, and [Caddy](https://caddyserver.com) in front, which gets the HTTPS certificate. Save it beside the `Dockerfile` as `docker-compose.prod.yml`:

```yaml
name: evieverse

services:
  postgres:
    extends: { file: compose.base.yml, service: postgres }
    restart: unless-stopped
    environment: { POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?set it in .env}' }
    volumes: [postgres:/var/lib/postgresql/data]

  redis:
    extends: { file: compose.base.yml, service: redis }
    restart: unless-stopped
    volumes: [redis:/data]

  app:
    extends: { file: compose.base.yml, service: app }
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://evieverse:${POSTGRES_PASSWORD}@postgres:5432/evieverse
      PUBLIC_BASE_URL: https://${DOMAIN}
      TRUST_PROXY: '1'
      SUPPORT_EMAIL: ${SUPPORT_EMAIL}
    volumes: [content:/app/data]

  caddy:
    image: caddy:2
    restart: unless-stopped
    depends_on: [app]
    command: caddy reverse-proxy --from ${DOMAIN} --to app:3000
    ports: ['80:80', '443:443']
    volumes: [caddy:/data]

volumes:
  postgres:
  redis:
  content:
  caddy:
```

Its three values go in `.env`, in the same directory, which git ignores:

```sh
DOMAIN=social.example.com
SUPPORT_EMAIL=you@example.com
POSTGRES_PASSWORD=<what `openssl rand -hex 24` prints>
```

```sh
docker compose -f docker-compose.prod.yml up -d --build
curl https://social.example.com/health
```

Then create the first admin and install the CLI as in [Getting started](#2-create-the-first-admin), with `docker compose -f docker-compose.prod.yml exec -e BOOTSTRAP_ADMIN="$ADMIN" app node dist/db/migrate.js` in place of the `docker exec`, and `URL=https://social.example.com`.

Things to know:

- **Only Caddy publishes ports:** 80 and 443, which is also how it gets its certificate. The server, Postgres and Valkey are reached from inside the stack alone. That's what makes `TRUST_PROXY: '1'` right: the server takes each client's address, which it limits requests by, from the one proxy in front of it, and nothing reaches it any other way.
- **`PUBLIC_BASE_URL`** is what the links to media in feeds are made from, and the address the CLI installs from.
- **Postgres takes its password when its volume is first made.** Changing `POSTGRES_PASSWORD` afterwards changes only what the server sends.
- **More settings go in the `environment` of `app`.** A browser client on another origin needs `CORS_ORIGINS`. For the instance's posts to be reposted on other instances, it needs `REPOSTS_SIGNING_KEYS` (`openssl rand -base64 32`).
- **Files are uploaded through the proxy,** in the request to `POST /store`, up to `MAX_UPLOAD_BYTES` (5 GiB). Caddy sets no limit on a request's size. Another proxy may: nginx's is 1 MB until you raise it.
- **Videos are the CPU work.** Where they're common, the server wants 2 CPUs and 2 GB of memory. On a smaller one, `VIDEO_PROCESSING: 'false'` stores them as they're sent, and fewer `VIDEO_HEIGHTS` cut the work.
- **Memory:** idle, the four containers took about 130 MB between them when this was tried. Valkey grows to 512 MB at most, as `compose.base.yml` sets it ([how much it needs](docs/DEPLOY.md#redis)).
- **Back up the database and the `content` volume:** they are the instance. Valkey holds nothing that can't be made again: `docker compose -f docker-compose.prod.yml exec app node dist/compact/main.js --rebuild --once`.
- **To upgrade,** `git pull`, then `docker compose -f docker-compose.prod.yml up -d --build`. The server brings the database up to date as it starts.
- **More than one server container** needs Valkey, the compactor in one container only, and a content store they all reach ([APP.md](docs/APP.md#13-deployment-topology)).

### Where the files go

A cloud deployment keeps posts' files in a bucket. A container needs none: where files are kept is a setting (`CONTENT_SCHEME`, `CONTENT_OPTIONS`), and it decides how they travel between clients and the instance.

**On a volume** (`CONTENT_SCHEME=fs`, the default):

- A file is read through the server: `GET /content/:id/raw` answers with its bytes.
- A file is sent in the request to `POST /store`. There are no upload links: `POST /uploads` answers `501`.
- Every container that runs the server or the compactor mounts the same volume. The server puts a new file there, and the compactor publishes it from there.

**In an S3-compatible store** (`CONTENT_SCHEME=s3`): a bucket at a storage provider, or a store in a container of its own, such as the RustFS this repo's other compose files run.

```sh
CONTENT_SCHEME=s3
CONTENT_OPTIONS='{"bucket":"evieverse","region":"us-east-1","endpoint":"https://files.example.com","access_key_id":"…","secret_access_key":"…"}'
```

- Files can go between clients and the store directly: `GET /content/:id/raw` redirects to a signed link to the file, and `POST /uploads` gives a signed link to upload one with.
- **`endpoint` must be an address clients reach too,** since the links are signed for it. With a name that only the containers resolve, such as `http://s3:9000`, the server itself works, and every link it gives fails outside the Docker network.
- The bucket needs what the cloud deployments give theirs ([DEPLOY.md](docs/DEPLOY.md#uploads)): CORS, for clients in a browser, and rules that delete what's under `uploads/` after a day and under `staged/` after a week.
- Changing the store doesn't move the files to it.

## Evieverse clients

Evieverse does not ship with a client apart from the admin CLI. It's designed for single-page apps that each work with several instances at once. A client should:

1. Allow the user to register on several instances with a single interface.
2. Keep one set of credentials that unlocks the user's API key for each instance.
3. Let the user set the parameters of each request, such as a feed's tags, window and algorithm.
4. Syndicate a post to several instances by reposting it appropriately. 


## Bring your own client

Every instance serves the same API, so anyone can register on an instance directly, keep their own key, and use whatever client they like. See [API.md](docs/API.md)

## User registration and API keys

When a user registers using the register endpoint(`POST /register`), unless pre-existing admin credentials are supplied (the CLI does this automatically), the instance responds with a challenge. Once the challenge is solved, the instance returns the user's id and an API key. The key is shown only once, so must be stored and kept safe. A user who still has their key can replace it with (`POST /users/:userId/key`, or `evieverse key rotate`). The details are in [API.md](docs/API.md#post-usersuseridkey).

## Profiles

Every user has a public profile (`GET /users/:userId`): their name, when their account was created, and what they choose to add to it.

- A bio of up to 500 characters, which can be formatted as a post's text can.
- Up to 10 links to where else they're found.
- An avatar. The instance makes every avatar the same size and type, a 400×400 WebP, whatever image was sent.
- Up to 5 of their own posts, pinned to the profile.

Anyone can list a user's posts, newest first (`GET /users/:userId/posts`). A bio, links and an avatar are moderated as posts are, and nothing a banned user put on their profile is shown while the ban lasts. See [API.md](docs/API.md#a-users-profile).

## Content organization and moderation

As on most social media, content is organized by tags (hashtags). An instance is deployed in one of two tagging modes:

- User-supplied tags (the default): a post gets up to 10 tags supplied by the user.
- Server-enforced tags: the instance's operator sets the tags a post is allowed to have. Clients get the list of allowed tags from the instance (`GET /tagging`).

In both modes, a post with no valid tags is rejected.

**Auto-moderation.** Every new post and update gets a trust score when it arrives. Depending on the score, the post is published, held in the moderation queue until someone reviews it, or rejected outright. Out of the box, a post containing a blocked word is assigned a trust score of zero. Additional [trust plugins](docs/TRUST_PLUGINS.md) may be used to modify the trust score further. Two optional plugins ship with the server: `urlhaus` refuses posts and comments with a link that spreads malware, and `pdq` gives a trust score of zero to one with an image that matches a list of known child sexual abuse material, and notifies the admins.

**Moderators** 

- **Admins** can delete any post, comment or account, ban users, accept or reject held posts and comments, keep the instance's blocked words, and appoint and remove server moderators and tag moderators.
- **Server moderators** accept or reject the posts and comments held in the moderation queue, accept or delete the posts and comments users reported, perform any operations a tag moderator could on any tag except appointing and removing its moderators, refuse claims to tags, and ban users.
- **Tag moderators** look after one or more tags. Under their tag, they can remove a tag from a post (with a reason, if they give one), mute a user, whose later posts then don't get the tag, and set the tag's rules. They can appoint other moderators of their tag, and remove the ones who became a moderator after them. They have no say over comments.

**Claiming a tag.** In the user-supplied tagging mode, a user can claim a tag that has no moderator (`evieverse claims add <tag>`). The admins and server moderators are notified in their inbox, and any of them can refuse the claim within 24 hours (`TAG_CLAIM_REVIEW_HOURS`). A claim nobody refused is granted, and the user becomes the tag's moderator. Users are notified when their claim is granted or refused, and when they are made a tag's moderator or removed as one. See [API.md](docs/API.md#claiming-a-hashtag).

**Moderation record.** When a tag moderator approves a post under a tag or removes a tag from it, that is recorded on the post, and anyone reading the post (`GET /content/:contentId`) gets it: which tag, whether a tag moderator, a server moderator or an admin did it (never who), when, and the reason a removal was given. See [API.md](docs/API.md#get-contentcontentid).

**Bans.** A server moderator or an admin can ban a user (`evieverse bans add <userId>`). A banned user can't post, comment or send messages, but can still read, receive messages, and delete their own posts and account. The user is notified of being banned and unbanned in their inbox. Admins and server moderators can't be banned until their role ends. See [API.md](docs/API.md#bans).

**Deleting accounts.** A user can delete their own account (`evieverse account delete --yes`), and an admin can delete any (`evieverse users delete <userId> --yes`) unless it's the only admin account. Posts are deleted with the account, comments stay. See [API.md](docs/API.md#delete-usersuserid).

**Data export.** A user can export everything the instance holds of them, a page at a time (`GET /users/:userId/export`). See [API.md](docs/API.md#get-usersuseridexport).

**Reports.** Any user can report a published post or comment. Reported posts and comments stay published and wait in the report queue, where a server moderator or an admin accepts or deletes it.

All of the moderation functions are available via the CLI [CLI](docs/CLI.md).

## Rules

The CLI (and API) allows the admin to set the server rules, which come back in the public `GET /rules` endpoint. The rules also send the modification disclosure clause as appropriate. 

A tag can have rules of its own, which its moderators set (`evieverse tag-rules add <tag> <text>`) and anyone can read (`GET /tags/:tag/rules`).

The details are in [API.md](docs/API.md#rules) and [CONFIG.md](docs/CONFIG.md).

## Posts

A post is one of five types:

- an image, a video or an audio file, each with an optional caption. An image post can be an album of up to 10 images;
- text, of up to 40,000 characters;
- a link, which is also how any other kind of file, such as a PDF, is shared.

Post and comment text can be formatted. See [TEXT_EDITORS.md](docs/TEXT_EDITORS.md).

**Mentions.** A post or a comment mentions a user with `@` and their username. The user is notified in their inbox, and the mention links to their profile. See [API.md](docs/API.md#mentions).

**Alt text.** Every image can have an alt text, which describes it to people who can't see it: each image of a post, a comment's image, and an ad's. Clients get it wherever they get the image. See [API.md](docs/API.md#alt-text).

**Video.** The server processes the videos it's sent, with ffmpeg, before it publishes them. See [API.md](docs/API.md#videos).

- A video is made an MP4 that plays on any device, with a poster image and an adaptive stream (HLS) in several sizes, so it plays on slow connections.
- Its metadata is removed, as an image's is: where and when it was filmed, and on what.
- The post is published once that's done, and says `processing` until then.
- `VIDEO_PROCESSING=false` turns it off: videos are then stored and served as they're sent.

## Reposts

Any content can be reposted to this server or to another server with additional tags that it did not have previously. 

- A repost to another server contains the URL to access the content, but it still lives on this instance of Evieverse
- A user cannot repost their own posts (but can change the tags by editing the post)
- A repost still goes through tag moderation for its new tags
- A repost to another server is signed by this instance, and the other server checks the signature before it takes the repost. 
- An instance can turn reposts off, or only those of posts on other instances (`REPOSTS`, `REPOSTS_REMOTE`). For its posts to be reposted elsewhere it needs a signing key (`REPOSTS_SIGNING_KEYS`), which the Terraform modules make, and which you make yourself anywhere else (`openssl rand -base64 32`).


## Comments

A post takes comments if its publisher turns them on, which is done on a post-by-post basis.

- A comment can consist of text, an image, or a video. A comment's video is processed as a post's is, into one MP4 without its metadata
- Comments are stored in a tree form on each post (users may respond to other users comments)
- Anyone can read a post's comments, oldest or newest first, and any user can add one, up to 10 a minute by default.
- Comments are moderated as posts are. Each gets a trust score from the same checks, and by the same thresholds is published, held in the moderation queue or rejected outright. Held comments wait in the same queue as held posts, for a server moderator or an admin.
- Comments can be reported - they go to the same report queue as reported posts.
- A comment can be deleted by its author, by the publisher of the post it's on, and by an admin.
- Turning comments off on a post closes and hides them without deleting them. 
- Deleting the post deletes all comments on it.
- Clients are responsible for providing sort options for comments

The details are in [API.md](docs/API.md#comments).

## Likes

A user can like any post once, and can take the like back, after which they can like the post again. A post's likes are shown wherever the post is, in feeds and on the post itself, and they're what the `popular` feed algorithm orders posts by.

## Following

A user can follow any other user, up to 1,000 of them by default. Followers and whom one follows can be optionally hidden by the user.

## Blocks

A user can block another user. No message goes between the two, neither follows the other, and the blocked user can't comment on the blocker's posts. See [API.md](docs/API.md#blocks).

## Inbox

Users receive notices and messages from other users in their inbox. Notices include server messages (e.g. moderated posts, bans) and mentions.

## Feed

A feed is what the reader asks for. The reader chooses:

- Tags: The system will return filtered content for one or more tags. If the related option is used, it will also return results for related tags. 
- A window: from the past hour to the past 90 days. A feed holds the posts of its window and no others.
- An algorithm:
  - `popular` (the default) returns the window's most liked posts first. The tags asked for take turns, and some places go to new posts nobody has liked yet, so that new posts get seen.
  - `chronological` returns the window's posts in order of time, newest first.
- Filters: AI-usage content filter. There is also a filter for only posts a tag's moderators have approved, or only posts they haven't.

## Search

Anyone can search an instance (`GET /search`) for users, by the start of their username, or for posts, by the words of their text and by their tags. See [API.md](docs/API.md#search).

An instance that had posts before it had search indexes them once after the upgrade (`npm run reindex`). See [DEPLOY.md](docs/DEPLOY.md#upgrading-to-search).



## Running an instance locally

[Getting started](#getting-started) runs an instance to use. These are the setups for working on the server, or on a client for it.

Requires Node 22+, and ffmpeg to process videos with (`brew install ffmpeg`, `apt install ffmpeg`). Without ffmpeg, run it with `VIDEO_PROCESSING=false`, which stores videos as they're sent: the server doesn't start otherwise, and says so. The Docker images have ffmpeg.

```bash
npm install
npm run dev            # SQLite in ./data, content and summaries in ./data/content, the index in memory
```

The server listens on `http://localhost:3000`. Other ways to run it:


| To run                                                                                                                                      | Command                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The testbed: an instance seeded with users and posts, and a web page for reading feeds, posting and registering, at `http://localhost:8080` | `docker compose -f testbed/docker-compose.yml up -d --build` |
| Just the API in Docker, for building a client against, at `http://localhost:3000` (Postgres, Valkey, and content on a local volume)         | `docker compose -f docker-compose.server.yml up -d --build`  |
| The full stack in Docker (Postgres, an S3-compatible store for content and summaries, Valkey for the index, and a separate compactor)       | `docker compose --profile app up --build`                    |


Things to know:

- `curl -fsSL http://localhost:3000/cli/install.sh | sh` downloads and installs the CLI, from an instance in Docker or one that was built (`npm run build`, then `npm start`). `npm run dev` ships none.
- The full stack gives links to its S3-compatible store by the name its containers know it by, `http://s3:9000`. So from the host, `GET /content/:id/raw` redirects to an address that doesn't resolve, and upload links point to it too ([Where the files go](#where-the-files-go)). The testbed has nginx in front, which sends the redirects on to the store.
- Without `REDIS_URL`, the feed index lives inside the process, and the server rebuilds it from the database and the content store each time it starts. To keep it across restarts, point `REDIS_URL` at a local Redis or Valkey (`docker compose up -d redis`, then `REDIS_URL=redis://127.0.0.1:6379`).
- The API in Docker (`docker-compose.server.yml`) accepts browser requests from any origin. Set `CORS_ORIGINS` (e.g. `CORS_ORIGINS=http://localhost:5173`) to allow only your frontend's. It's set up for development in other ways too: it raises the limits on registrations and feeds, and publishes Postgres (with the password in `compose.base.yml`) and Valkey (with none) on the host. For an instance on the internet, use [A server on the internet](#a-server-on-the-internet).



## Configuration

See [CONFIG.md](docs/CONFIG.md)

## Tests

Commands to run tests:

```bash
npm test     # unit tests, migration tests, API and feed-index tests on SQLite with the in-process store
docker compose up -d postgres mysql redis
TEST_POSTGRES_URL=postgres://evieverse:evieverse@localhost:5432/evieverse \
TEST_MYSQL_URL=mysql://evieverse:evieverse@localhost:3306/evieverse \
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
npm run check    # the conventions of src that the compiler doesn't check: where interfaces are, JSDoc comments, constants at the top
```

Optionally add `--no-file-parallelism` to run the tests one at a time.

## Benchmarks

Running the benchmarks:

```bash
npm run bench     # load-tests the API in Docker and writes BENCHMARKS.md again, in about 5 minutes
# The settings a run can be given, at their defaults:
BENCH_SERVER_CPUS=2 BENCH_SERVER_MEMORY=2g BENCH_DURATION_SECONDS=10 BENCH_CONNECTIONS=50 BENCH_POSTS=2000 npm run bench
```

Requires Docker

See [[BENCHMARKS.md](BENCHMARKS.md)] for the latest benchmark output. Note: this file is regenerated by the benchmark script. Do not edit it. 

Please run the benchmarking script before submitting PRs that touch API operations. If your PR does not show this file changed, it will be rejected. 

## AI-Usage Disclosure

AI tools, including Generative AI tools, were used in the planning, development, and analysis of Evieverse. Use of these tools has become standard practice in the software development world. I, a software engineer with over 20 years of professional experience, would not have been able to create Evieverse in any reasonable timeframe without them. Particular care was taken to "desloppify" AI output and perfect the product's codebase. If you find, and wish to remove, slop from this application, then open a PR. 

## License

See [[LICENSE.md](LICENSE.md)]

## Public Evieverse Servers

Running a server? Put it here!

## Client Implementations

Open a PR to see your client implementation here!

## Code Owners

Evelynn McDermott [contact@techfalos.com](mailto:contact@techfalos.com)