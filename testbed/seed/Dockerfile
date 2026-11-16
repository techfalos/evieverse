# Built from the repository root (see testbed/docker-compose.yml). Runs the seed with tsx against src/.
FROM node:22-trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY testbed/seed ./testbed/seed
CMD ["node_modules/.bin/tsx", "testbed/seed/seed.ts"]
