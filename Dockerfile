# One file, three images:
#
#   docker build .                       what a deployment with a Redis and a database of its own runs, in
#                                        one container for each role: the API (the default command), a
#                                        function (dist/functions/*.js) or the compactor (`compactor`)
#   docker build --target standalone .   a whole server in one container: the API, the compactor and a
#                                        Valkey of its own (src/standalone.ts)
#
# Both are the `runtime` stage below with another command, so they hold the same server.

# The TypeScript: the API, compiled, with the packages it runs on.
FROM node:22-trixie-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY languages ./languages
COPY src ./src
RUN npm run build && npm prune --omit=dev

# The Rust, all of which is under compactor/: the compactor's program, and the addon the API loads
# (compactor/crates/node). The version is the one compactor/rust-toolchain.toml pins, and the Debian the
# one they run on below. As a release is built: without the test harness or the tests' plugin.
FROM rust:1.100.0-slim-trixie AS native
WORKDIR /app
# A C compiler and cmake: for SQLite, the engine that runs blocked patterns, zstd and the TLS library, which are built from source.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config && rm -rf /var/lib/apt/lists/*
COPY compactor ./compactor
# The schema's migrations, which the build reads the newest one's name from: what a process waits for the database to have.
COPY src/db/migrations ./src/db/migrations
RUN cd compactor && cargo build --release --locked -p compactor -p evieverse-node

# What every image runs. trixie, not bookworm: opendal's native binding needs glibc 2.38 or later.
FROM node:22-trixie-slim AS runtime
WORKDIR /app
# ffmpeg: what the video worker, which is part of the compactor, processes the videos users send with
# (compactor/src/video). The one image runs the API and the compactor, so both have it; a server that
# processes no videos (VIDEO_PROCESSING=false) needs none.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# A container's own files go when the container is replaced, so a SQLite database has to be on a mounted
# volume (docker run -v evieverse:/app/data ...): the server doesn't start on one that isn't (src/db/volume.ts).
# Postgres and MySQL keep their data themselves. There is no VOLUME here on purpose: Docker would then make a
# volume without a name for each container, which the next container doesn't use.
ENV DB_REQUIRE_VOLUME=true
# The first time the server (dist/server.js) starts, on a database with no admin, it creates one, named
# "admin", and writes its profile for the CLI, API key included, here, beside the data (src/moderation/firstAdmin.ts).
ENV FIRST_ADMIN_PROFILE=/app/data/admin-profile.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Where the API looks for its addon, and what starts the compactor for it (src/native.ts): native/, beside dist/.
COPY --from=native /app/compactor/target/release/libevieverse_node.so ./native/evieverse.node
COPY --from=native /app/compactor/target/release/compactor ./native/compactor
# The compactor by its name, wherever it is run from: `compactor`, `compactor --rebuild --once`, `compactor reindex`.
RUN ln -s /app/native/compactor /usr/local/bin/compactor
COPY languages ./languages
COPY package.json ./
EXPOSE 3000

# A whole server in one container: Valkey, the API and the compactor, which src/standalone.ts starts and
# ends together. Its data is all on the one volume (docker run -v evieverse:/app/data ...): the SQLite
# database, the content's files and Valkey's (/app/data/valkey). DB_DIALECT and DATABASE_URL move the
# database out of it, CONTENT_SCHEME and CONTENT_OPTIONS the files, and REDIS_URL the feed index.
FROM runtime AS standalone
# tini: the container's first process, which passes signals on and reaps what the others leave behind.
RUN apt-get update && apt-get install -y --no-install-recommends valkey-server tini && rm -rf /var/lib/apt/lists/*
# The container's own Valkey, which is started for as long as this names it, and is what a command run
# in the container finds (docker exec ... compactor --rebuild --once). Any other address: the Redis or
# Valkey there is used, and none is started here.
ENV REDIS_URL=redis://127.0.0.1:6379
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/standalone.js"]

# The last stage, so the one a build with no --target makes: the API alone. The compactor is the same
# image with the command `compactor`, in a container of its own, and Redis is somewhere else (REDIS_URL).
FROM runtime
CMD ["node", "dist/server.js"]
