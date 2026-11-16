import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { AppDeps } from './deps.js';
import { registerErrorHandler } from './http/errors.js';
import { contentRoutes } from './routes/content.js';
import { federatedRoutes } from './routes/federated.js';
import { feedRoutes } from './routes/feed.js';
import { followRoutes } from './routes/follow.js';
import { likeRoutes } from './routes/like.js';
import { moderationRoutes } from './routes/moderation.js';
import { registerRoutes } from './routes/register.js';
import { storeRoutes } from './routes/store.js';
import { tagRoutes } from './routes/tags.js';

export async function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify({ logger: { level: deps.config.logLevel }, ...opts });

  registerErrorHandler(app);
  const { corsOrigins } = deps.config;
  if (corsOrigins.length > 0) {
    await app.register(cors, {
      origin: corsOrigins.includes('*') ? '*' : corsOrigins,
      // The plugin allows only GET, HEAD and POST unless told otherwise.
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-publisher-url', 'content-disposition'],
      maxAge: 600,
    });
  }
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: deps.config.storage.maxUploadBytes,
      files: 1,
      fields: 20,
      fieldSize: 32 * 1024 * 1024,
    },
  });

  app.get('/health', async () => ({ ok: true }));
  registerRoutes(app, deps);
  storeRoutes(app, deps);
  federatedRoutes(app, deps);
  likeRoutes(app, deps);
  followRoutes(app, deps);
  contentRoutes(app, deps);
  moderationRoutes(app, deps);
  const { config, feedReader, authorReader, summaries, publishers, follows, now } = deps;
  feedRoutes(app, { config, feedReader, authorReader, summaries, publishers, follows, now });
  tagRoutes(app, deps);

  return app;
}
