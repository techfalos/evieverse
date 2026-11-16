# Built from the repository root (see bench/docker-compose.yml). Both of the benchmark's containers
# run from it: the server with tsx against src/, and what sends it requests with vitest.
FROM node:22-trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.bench.config.ts ./
COPY languages ./languages
COPY src ./src
COPY testbed/seed ./testbed/seed
COPY bench ./bench
