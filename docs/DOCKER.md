# Docker Configuration

How an Evieverse instance runs in Docker: the stack [Getting started](../README.md#getting-started) starts, its first admin, a server on the internet, where posts' files go, and deploying a change. For an instance on AWS, Google Cloud or Azure, see [IAC.md](IAC.md).

One image runs every role of an instance ([`Dockerfile`](../Dockerfile)), and has ffmpeg for videos. It isn't published to a registry, so build it from a clone. An instance is that image with a Redis or Valkey beside it, which holds the feed index: the server doesn't start without `REDIS_URL`. Every other piece starts out inside the server's container, and moves out of it with a setting ([CONFIG.md](CONFIG.md)):

| Piece                                  | With no setting of its own                    | To change it                                                                                                                         |
| -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Database                               | SQLite, a file on the volume (`/app/data`)    | `DB_DIALECT` and `DATABASE_URL`: Postgres or MySQL, in a container or anywhere else                                                  |
| Feed index                             | None: `REDIS_URL` is required                 | `REDIS_URL`: Valkey or Redis, not in cluster mode, with the `volatile-lru` eviction policy, in a container or anywhere else          |
| Posts' files                           | Files on the volume (`/app/data/content`)     | `CONTENT_SCHEME` and `CONTENT_OPTIONS`: an S3-compatible store ([Where the files go](#where-the-files-go))                           |
| Compactor, which also processes videos | Inside the server                             | `COMPACT_IN_PROCESS=false`, and a second container with the same image, settings and volumes that runs `node dist/compact/main.js`  |
| HTTPS                                  | None: plain HTTP on port 3000                 | A reverse proxy in front, with `PUBLIC_BASE_URL` and `TRUST_PROXY`                                                                   |

## The stack Getting started runs

```sh
docker compose -f docker-compose.server.yml up -d --build
curl http://localhost:3000/health         # {"ok":true}
```

[`docker-compose.server.yml`](../docker-compose.server.yml) builds the image and runs three containers: the server at `http://localhost:3000`, Postgres and Valkey. Posts' files are on a volume, and the compactor runs inside the server.

- Its settings are shell or `.env` variables that the file reads, such as `SERVER_PORT`, `CORS_ORIGINS`, `TAGGING_MODE` and `SUPPORT_EMAIL`. The file lists them all.
- It's set up for a machine of your own, not for the internet. It accepts browser requests from any origin (`CORS_ORIGINS`), raises the limits on registrations and feeds, and publishes Postgres on port 25432 (with the password in `compose.base.yml`) and Valkey on port 26379 (with none). For an instance on the internet, use [A server on the internet](#a-server-on-the-internet).
- To start over, `docker compose -f docker-compose.server.yml down -v` removes the containers and their data.

## The first admin

Nothing creates an admin for an instance in Docker. You make the admin's id and API key yourself, and give the server the key's hash:

```sh
USER_ID="$(node -p 'crypto.randomUUID()')"
KEY="ev_$(node -p 'crypto.randomBytes(6).toString("hex") + "_" + crypto.randomBytes(32).toString("base64url")')"
HASH="$(node -p 'crypto.createHash("sha256").update(process.argv[1]).digest("hex")' "$KEY")"
ADMIN="{\"userId\":\"$USER_ID\",\"username\":\"admin\",\"keyHash\":\"$HASH\"}"

docker compose -f docker-compose.server.yml exec -e BOOTSTRAP_ADMIN="$ADMIN" app node dist/db/migrate.js
```

```
Migrations complete (postgres).
Admin account admin (10e57144-…) created.
```

`$KEY` is the admin's API key. The server keeps only its hash, so the key exists nowhere else until the CLI saves it. With the CLI [installed](../README.md#2-installing-the-cli), sign in as the admin:

```sh
EVIEVERSE_API_KEY="$KEY" evieverse --profile evieverse login http://localhost:3000 "$USER_ID"
```

```
Signed in to http://localhost:3000 as admin (an admin).
```

See [CONFIG.md](CONFIG.md#bootstrap_admin) for `BOOTSTRAP_ADMIN`, and [CLI.md](CLI.md) for the CLI.

## A server on the internet

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

Then create [the first admin](#the-first-admin) and install the CLI, with `-f docker-compose.prod.yml` in place of `-f docker-compose.server.yml`, and `https://social.example.com` in place of `http://localhost:3000`.

Things to know:

- Only Caddy publishes ports: 80 and 443, which is also how it gets its certificate. The server, Postgres and Valkey are reached from inside the stack alone. That's what makes `TRUST_PROXY: '1'` right: the server takes each client's address, which it limits requests by, from the one proxy in front of it, and nothing reaches it any other way.
- `PUBLIC_BASE_URL` is what the links to media in feeds are made from, and the address the CLI installs from.
- Postgres takes its password when its volume is first made. Changing `POSTGRES_PASSWORD` afterwards changes only what the server sends.
- More settings go in the `environment` of `app`. A browser client on another origin needs `CORS_ORIGINS`. For the instance's posts to be reposted on other instances, it needs `REPOSTS_SIGNING_KEYS` (`openssl rand -base64 32`).
- Files are uploaded through the proxy, in the request to `POST /store`, up to `MAX_UPLOAD_BYTES` (5 GiB). Caddy sets no limit on a request's size. Another proxy may: nginx's is 1 MB until you raise it.
- Videos are the CPU work. Where they're common, the server wants 2 CPUs and 2 GB of memory. On a smaller one, `VIDEO_PROCESSING: 'false'` stores them as they're sent, and fewer `VIDEO_HEIGHTS` cut the work.
- Memory: idle, the four containers took about 130 MB between them when this was tried. Valkey grows to 512 MB at most, as `compose.base.yml` sets it ([how much it needs](IAC.md#redis)).
- Back up the database and the `content` volume: they are the instance. Valkey holds nothing that can't be made again: `docker compose -f docker-compose.prod.yml exec app node dist/compact/main.js --rebuild --once`.
- To upgrade, `git pull`, then `docker compose -f docker-compose.prod.yml up -d --build`. The server brings the database up to date as it starts.
- More than one server container needs the compactor in one container only, and a content store they all reach ([APP.md](APP.md#13-deployment-topology)).

## Where the files go

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
- `endpoint` must be an address clients reach too, since the links are signed for it. With a name that only the containers resolve, such as `http://s3:9000`, the server itself works, and every link it gives fails outside the Docker network.
- The bucket needs what the cloud deployments give theirs ([IAC.md](IAC.md#uploads)): CORS, for clients in a browser, and rules that delete what's under `uploads/` after a day and under `staged/` after a week.
- Changing the store doesn't move the files to it.

## Deploying a change

Change the setting where the stack reads it, then have Compose recreate the containers whose settings changed. [CONFIG.md](CONFIG.md) lists the settings and how to write a value, and [IAC.md](IAC.md#deploying-a-change) has the same for a Terraform deployment.

A setting is read by each process on its own, so every process that reads it needs the new value: the server, and the compactor where it runs in a container of its own. A stack whose containers share their settings gives it to both.

Where the setting goes depends on the stack:

- `docker-compose.server.yml`: the shell or `.env` variable the file reads, such as `CORS_ORIGINS`, `TAGGING_MODE` and `TAGGING_SERVER_TAGS`, or the `environment:` of `app`.
- `docker-compose.prod.yml`: the `environment:` of `app`, or its `.env`.
- [`docker-compose.yml`](../docker-compose.yml) and [`testbed/docker-compose.yml`](../testbed/docker-compose.yml): the `x-app-env` block, which the compactor shares with the server, or the `environment:` of the service.

Then recreate the containers. Their data volumes stay:

```sh
docker compose -f docker-compose.server.yml up -d
docker compose -f docker-compose.prod.yml up -d
docker compose --profile app up -d
docker compose -f testbed/docker-compose.yml up -d
```

A change to a **language or a plugin** is a change to the code, which is part of the image: add `--build`. A change to a setting never needs a rebuild.

A value the server refuses stops it as it starts, with the name of the setting: `docker compose -f docker-compose.server.yml logs app` shows it.
