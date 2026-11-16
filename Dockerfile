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

# trixie, not bookworm: opendal's native binding needs glibc 2.38 or later.
FROM node:22-trixie-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY languages ./languages
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/server.js"]
