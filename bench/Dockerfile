# Built from the repository root (see bench/docker-compose.yml). Both of the benchmark's containers
# run from it: the server with tsx against src/, and what sends it requests with vitest. The server
# loads the addon and runs the compactor beside it: both are in native/, beside src/, where
# src/native.ts looks for them.
# The Rust, as the server's own image builds it (the `native` stage of the Dockerfile, line for line, so
# the two share what Docker keeps of the build): the compactor's program and the addon the API loads.
FROM rust:1.100.0-slim-trixie AS native
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config && rm -rf /var/lib/apt/lists/*
COPY compactor ./compactor
COPY src/db/migrations ./src/db/migrations
RUN cd compactor && cargo build --release --locked -p compactor -p evieverse-node

FROM node:22-trixie-slim
WORKDIR /app
# ffmpeg: a server processes the videos it is sent unless it is set not to, and its compactor doesn't start without what does that.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.bench.config.ts ./
COPY languages ./languages
COPY src ./src
COPY testbed/seed ./testbed/seed
COPY bench ./bench
COPY --from=native /app/compactor/target/release/libevieverse_node.so ./native/evieverse.node
COPY --from=native /app/compactor/target/release/compactor ./native/compactor
