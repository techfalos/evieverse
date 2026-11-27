# Docker Configuration

How an Evieverse instance runs in Docker: the container [Getting started](../README.md#getting-started) starts, its first admin, a server on the internet, where posts' files go, and deploying a change. For an instance on AWS, Google Cloud or Azure, see [IAC.md](IAC.md).

An instance is three programs: the API, the compactor, which is the only writer of what's published and also processes videos, and a Redis or Valkey, which holds the feed index. Neither the API nor the compactor starts without `REDIS_URL`.

The [`Dockerfile`](../Dockerfile) builds two images, which aren't published to a registry, so build them from a clone:

| Image | Built with | What a container of it runs |
| --- | --- | --- |
| The whole server | `--target standalone` | All three: the API, the compactor and a Valkey of its own. One container is an instance. |
| One role | No target | The API, or the compactor when its command is `compactor`. An instance is then one or more containers that run the API, one that runs the compactor, and a Redis or Valkey they all reach. |

Both have ffmpeg for videos. Both hold the compactor and the trust plugins, which are written in Rust (`compactor/`), so building an image compiles them. The first build takes several minutes. Later ones reuse what was compiled until a file under `compactor/` changes or a migration is added.

In the whole-server image every piece starts out inside the one container, and moves out of it with a setting ([CONFIG.md](CONFIG.md)):

| Piece | With no setting of its own | To change it |
| --- | --- | --- |
| Database | SQLite, a file on the volume (`/app/data/evieverse.sqlite`) | `DB_DIALECT` and `DATABASE_URL`: Postgres or MySQL, in a container or anywhere else |
| Feed index | The container's own Valkey, which keeps its data on the volume (`/app/data/valkey`) and holds at most `VALKEY_MAXMEMORY` (`512mb`) | `REDIS_URL`: a Valkey or Redis somewhere else, not in cluster mode, with the `volatile-lru` eviction policy. The container then starts none of its own |
| Posts' files | Files on the volume (`/app/data/content`) | `CONTENT_SCHEME` and `CONTENT_OPTIONS`: an S3-compatible store ([Where the files go](#where-the-files-go)) |
| Compactor | Inside the container, beside the API | The one-role image: a container of its own that runs `compactor`, with the API's settings and volumes ([A server on the internet](#a-server-on-the-internet)) |
| HTTPS | None: plain HTTP on port 3000 | A reverse proxy in front, with `PUBLIC_BASE_URL` and `TRUST_PROXY` |

Everything a container keeps is under `/app/data`, so mount a volume there. A container's own files go when the container is replaced, so the image doesn't start on a SQLite database that isn't on a mounted volume (`DB_REQUIRE_VOLUME`, which the image sets): it stops with an error that says so, instead of losing the database later.

## The container Getting started runs

```sh
docker compose -f docker-compose.server.yml up -d --build
curl http://localhost:3000/health         # {"ok":true}
```

[`docker-compose.server.yml`](../docker-compose.server.yml) builds the whole-server image and runs one container of it, `app`: the server at `http://localhost:3000`, with the database, posts' files and Valkey's data on one volume.

- Its settings are shell or `.env` variables that the file reads, such as `SERVER_PORT`, `CORS_ORIGINS`, `TAGGING_MODE` and `SUPPORT_EMAIL`. The file lists them all.
- Dislikes are off, as on any instance that doesn't say otherwise. `DISLIKES=true` turns them on ([CONFIG.md](CONFIG.md#dislikes)): every post's `dislikes` is then its count, where it was `null`.
- It's set up for a machine of your own, not for the internet. It accepts browser requests from any origin (`CORS_ORIGINS`), and raises the limits on registrations and feeds. For an instance on the internet, use [A server on the internet](#a-server-on-the-internet).
- It publishes port 3000 and nothing else. The container's Valkey listens inside the container alone, with no password, and the database is a file.
- The three programs start and end together: Valkey first, then the API, then the compactor. If one of them ends, the container stops the other two and exits with `1`, so a restart policy starts all three again (`restart: unless-stopped`, which this file doesn't set). `docker compose stop` gives them 30 seconds to finish: the requests under way, the compactor's pass, and Valkey writing what it holds.
- All three write to the container's log: `docker compose -f docker-compose.server.yml logs -f app`.
- The compactor is also a command inside the container, for what is run by hand: `docker compose -f docker-compose.server.yml exec app compactor --rebuild --once` makes the feed index again from the database and the content store, and `exec app compactor reindex` writes again what search reads, and counts the posts that aren't counted yet.
- To start over, `docker compose -f docker-compose.server.yml down -v` removes the container and its data.

Without Compose, it's the same image and one volume:

```sh
docker build --target standalone -t evieverse-standalone .
docker run -d --name evieverse -p 3000:3000 -v evieverse:/app/data evieverse-standalone
```

## The first admin

The first time the server starts, on a database with no admin, it creates one, named `admin`, with a new API key. It writes the account's profile for the CLI, key included, to `/app/data/admin-profile.json` on the volume. Copy it to where the CLI keeps its profiles:

```sh
mkdir -p ~/.evieverse/profiles
docker compose -f docker-compose.server.yml cp app:/app/data/admin-profile.json ~/.evieverse/profiles/evieverse.json
```

With the CLI [installed](../README.md#2-installing-the-cli), that profile is signed in as the admin:

```sh
evieverse --profile evieverse whoami
```

```
admin (10e57144-…) on http://localhost:3000: an admin
```

Things to know:

- The file holds the admin's API key, and only its owner can read it. The server itself keeps the key's hash alone, so the file is the one place the key is. Once it's copied, delete it from the volume: `docker compose -f docker-compose.server.yml exec app rm /app/data/admin-profile.json`.
- The server creates an admin only on a database that has none. Later starts create nothing and leave the file as it is, so a file that is still there holds the key the account had at first, which its owner may have replaced since.
- The profile names the server by `PUBLIC_BASE_URL`, or by `http://localhost:<PORT>` where that isn't set. Set `PUBLIC_BASE_URL` before the first start, or change `server` in the copy.
- Where another user already has the name `admin`, nothing is created, and the log says so. Make a user an admin by hand: `docker compose -f docker-compose.server.yml exec app node dist/moderation/admin.js grant <username or userId>`.
- A server whose file can't be written doesn't start, and creates nothing.
- What turns this on is `FIRST_ADMIN_PROFILE`, which both images set to that path, and which only the API reads. A stack whose API containers mount no volume at `/app/data` should set it to a path on one. See [CONFIG.md](CONFIG.md#server) for it, and [CONFIG.md](CONFIG.md#bootstrap_admin) for `BOOTSTRAP_ADMIN`, which creates an admin whose key you make yourself, as the Terraform modules do.

See [CLI.md](CLI.md) for the CLI.

## A server on the internet

What follows puts an instance on one server that a domain name points at: the API and the compactor on Postgres and Valkey, each in a container of its own, posts' files on a volume, and [Caddy](https://caddyserver.com) in front, which gets the HTTPS certificate. Save it beside the `Dockerfile` as `docker-compose.prod.yml`:

```yaml
name: evieverse

# What the API and the compactor share: each reads its settings for itself.
x-app-env: &app-env
  DATABASE_URL: postgres://evieverse:${POSTGRES_PASSWORD}@postgres:5432/evieverse
  PUBLIC_BASE_URL: https://${DOMAIN}
  TRUST_PROXY: '1'
  SUPPORT_EMAIL: ${SUPPORT_EMAIL}

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
    image: evieverse
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment: *app-env
    volumes: [content:/app/data]

  compactor:
    extends: { file: compose.base.yml, service: app }
    image: evieverse
    restart: unless-stopped
    command: ['compactor']
    healthcheck: { disable: true }
    depends_on:
      app: { condition: service_healthy }
    environment: *app-env
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

Then copy [the first admin](#the-first-admin)'s profile and install the CLI, with `-f docker-compose.prod.yml` in place of `-f docker-compose.server.yml`, and `https://social.example.com` in place of `http://localhost:3000`.

Things to know:

- Only Caddy publishes ports: 80 and 443, which is also how it gets its certificate. The API, the compactor, Postgres and Valkey are reached from inside the stack alone. That's what makes `TRUST_PROXY: '1'` right: the server takes each client's address, which it limits requests by, from the one proxy in front of it, and nothing reaches it any other way.
- `PUBLIC_BASE_URL` is what the links to media in feeds are made from, and the address the CLI installs from.
- Postgres takes its password when its volume is first made. Changing `POSTGRES_PASSWORD` afterwards changes only what the server sends.
- The API and the compactor are the same image with a different command, and read the same settings and the same volume. The API brings the database up to date as it starts, and the compactor waits for that. There is one compactor, however many containers run the API.
- More settings go in `x-app-env`, which gives them to both. A browser client on another origin needs `CORS_ORIGINS`. For the instance's posts to be reposted on other instances, it needs `REPOSTS_SIGNING_KEYS` (`openssl rand -base64 32`). For posts to be disliked, it needs `DISLIKES: 'true'`.
- Files are uploaded through the proxy, in the request to `POST /store`, up to `MAX_UPLOAD_BYTES` (5 GiB). Caddy sets no limit on a request's size. Another proxy may: nginx's is 1 MB until you raise it.
- Videos are the CPU work, and the compactor's container does it. Where they're common, the server wants 2 CPUs and 2 GB of memory. On a smaller one, `VIDEO_PROCESSING: 'false'` stores them as they're sent, and fewer `VIDEO_HEIGHTS` cut the work.
- Memory: Valkey grows to 512 MB at most, as `compose.base.yml` sets it ([how much it needs](IAC.md#redis)).
- Back up the database and the `content` volume: they are the instance. Valkey holds nothing that can't be made again: `docker compose -f docker-compose.prod.yml exec compactor compactor --rebuild --once`.
- To upgrade, `git pull`, then `docker compose -f docker-compose.prod.yml up -d --build`. The API brings the database up to date as it starts.
- More than one container that runs the API needs a content store they all reach ([APP.md](APP.md#13-deployment-topology)).
- The whole-server image does the same in one container, on SQLite and its own Valkey: the `app` of `docker-compose.server.yml` with `restart: unless-stopped`, `PUBLIC_BASE_URL`, `TRUST_PROXY: '1'`, its own `CORS_ORIGINS`, and without the two raised limits and the published port, behind the same `caddy` service.

### Upgrading an instance from before the Rust compactor

The compactor used to run inside the server, and no longer can. An instance from then needs three things when it's upgraded:

1. A compactor: the `compactor` service above, or the whole-server image. Without one, new posts are accepted and never published. A container that ran `node dist/compact/main.js` runs `compactor` instead.
2. `COMPACT_IN_PROCESS` taken out of its settings. Nothing reads it any more.
3. The search index made again, once, after the new containers are up: `docker compose -f docker-compose.prod.yml exec compactor compactor reindex`. The new compactor cuts text into words by rules that differ in places from the old one's, so a post indexed before may not be found by all of its words until then.

`docker-compose.server.yml` itself changed with it. It used to run three containers, with the database in Postgres and posts' files on a volume named `content`. It's now the one container, on SQLite and a volume named `data`, so it starts a new, empty instance, and moves nothing across. The old volumes stay until `down -v` removes them (`evieverse-server_postgres`, `evieverse-server_content`). To keep that instance, run it as the stack above with `name: evieverse-server`, which finds those volumes by their names, and with the database password of `compose.base.yml`, which is what its Postgres was made with.

### Upgrading to views and dislikes

Every post now counts its views, and its dislikes on an instance that turns them on ([API.md](API.md#views), [`POST /dislike`](API.md#post-dislike)). The upgrade is the usual one, `git pull` and `up -d --build`, and needs nothing set and nothing run by hand:

- The API adds the columns and the table as it starts (migration `0018_views_dislikes`). The posts that are there start with 0 views and 0 dislikes.
- The feed index has a new layout, since its entries hold the two counts. The new API reads the old layout too, and the new compactor writes a hashtag's index in the new one the first time anything happens under that hashtag. Until then its feeds are as before, with `views: 0`. To upgrade every hashtag at once, make the index again: `exec app compactor --rebuild --once`, or `exec compactor compactor --rebuild --once` in the stack above.
- The API has to be of the new version before the compactor is: the API of the version before can't read what the new compactor writes, and its feeds would be missing posts. Both stacks here keep to that. In the whole-server image the two are one container. In the stack above the compactor starts only once the API is healthy, and by then the API's container is the new one. Where containers that run the API are started some other way, on other machines say, replace every one of them before the compactor's.
- Going back to the version before takes the index made again by that version's compactor (`compactor --rebuild --once`), which writes the old layout. The counts stay in the database.
- Valkey holds about a third more for the index, 33 bytes for each post under each hashtag where it was 25 ([how much it needs](IAC.md#redis)).
- Dislikes stay off until `DISLIKES` says otherwise. Views have no setting.

### Upgrading to post counts

The instance now counts its posts, and each hashtag's: [`GET /rules`](API.md#get-rules) gives the first as `postCount`, and [`GET /tags`](API.md#get-tags) gives each hashtag's, can list the hashtags by it, and comes a page at a time. The upgrade is the usual one, `git pull` and `up -d --build`, with nothing to set and one thing to run by hand afterwards:

- The API adds the columns and the table as it starts (migration `0020_post_counts`). Every count starts at 0, whatever posts are there.
- The compactor counts each post as it writes it out from then on: a new post, an update, and a post whose hashtags a repost or a moderator changed. The posts from before aren't counted until something writes them again.
- So count those once, after the new containers are up: `exec app compactor reindex`, or `docker compose -f docker-compose.prod.yml exec compactor compactor reindex` in the stack above. It runs beside the API and the compactor, and can be run again: a post that's counted already is left as it is. Until it has run, the counts are short of the posts from before.
- A client that read `GET /tags` before reads it as it did: the most recently active first, 200 hashtags unless it asks for more. What's new is each hashtag's `postCount` and the list's `nextCursor`.
- The counts are the new compactor's to keep. A compactor of the version before, run on this database, counts nothing, and a post it deletes stays in the counts ([IAC.md](IAC.md#upgrading-to-post-counts) says how to count again from nothing).

## Where the files go

A cloud deployment keeps posts' files in a bucket. A container needs none: where files are kept is a setting (`CONTENT_SCHEME`, `CONTENT_OPTIONS`), and it decides how they travel between clients and the instance.

**On a volume** (`CONTENT_SCHEME=fs`, the default):

- A file is read through the server: `GET /content/:id/raw` answers with its bytes.
- A file is sent in the request to `POST /store`. There are no upload links: `POST /uploads` answers `501`.
- Every container that runs the API or the compactor mounts the same volume. The API puts a new file there, and the compactor publishes it from there. In the whole-server image they are one container, with one volume.

**In an S3-compatible store** (`CONTENT_SCHEME=s3`): a bucket at a storage provider, or a store in a container of its own, such as the RustFS this repo's other compose files run.

```sh
CONTENT_SCHEME=s3
CONTENT_OPTIONS='{"bucket":"evieverse","region":"us-east-1","endpoint":"https://files.example.com","access_key_id":"…","secret_access_key":"…"}'
```

- Files can go between clients and the store directly: `GET /content/:id/raw` redirects to a signed link to the file, and `POST /uploads` gives a signed link to upload one with.
- `endpoint` must be an address clients reach too, since the links are signed for it. With a name that only the containers resolve, such as `http://s3:9000`, the server itself works, and every link it gives fails outside the Docker network.
- The bucket needs what the cloud deployments give theirs ([IAC.md](IAC.md#uploads)): CORS, for clients in a browser, and rules that delete what's under `uploads/` after a day and under `staged/` after a week.
- Changing the store doesn't move the files to it.

## Deploying a change

Change the setting where the stack reads it, then have Compose recreate the containers whose settings changed. [CONFIG.md](CONFIG.md) lists the settings and how to write a value, and [IAC.md](IAC.md#deploying-a-change) has the same for a Terraform deployment.

A setting is read by each program on its own, so each one that reads it needs the new value: the API and the compactor. In the whole-server image they share one container's environment. In a stack that runs them apart, give it to both containers, which a shared block such as `x-app-env` does.

Where the setting goes depends on the stack:

- `docker-compose.server.yml`: the shell or `.env` variable the file reads, such as `CORS_ORIGINS`, `TAGGING_MODE` and `TAGGING_SERVER_TAGS`, or the `environment:` of `app`.
- `docker-compose.prod.yml`: the `x-app-env` block, which the compactor shares with the API, or its `.env`.
- [`docker-compose.yml`](../docker-compose.yml) and [`testbed/docker-compose.yml`](../testbed/docker-compose.yml): the `x-app-env` block, which the compactor shares with the API, or the `environment:` of the service.

Then recreate the containers. Their data volumes stay:

```sh
docker compose -f docker-compose.server.yml up -d
docker compose -f docker-compose.prod.yml up -d
docker compose --profile app up -d
docker compose -f testbed/docker-compose.yml up -d
```

A change to a **language or a plugin** is a change to the code, which is part of the image: add `--build`. A plugin is compiled, so that build takes longer than one that changed a language. A change to a setting never needs a rebuild.

A value the API or the compactor refuses stops it as it starts, with the name of the setting: `docker compose -f docker-compose.server.yml logs app` shows it, and `logs compactor` where the compactor has a container of its own.
