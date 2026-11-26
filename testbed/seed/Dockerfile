# Built from the repository root (see testbed/docker-compose.yml). Runs the seed with tsx against src/,
# which loads the server's addon and, for the feed index, runs the compactor: both are in native/,
# beside src/, where src/native.ts looks for them.
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
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY languages ./languages
COPY src ./src
COPY testbed/seed ./testbed/seed
COPY --from=native /app/compactor/target/release/libevieverse_node.so ./native/evieverse.node
COPY --from=native /app/compactor/target/release/compactor ./native/compactor
CMD ["node_modules/.bin/tsx", "testbed/seed/seed.ts"]
