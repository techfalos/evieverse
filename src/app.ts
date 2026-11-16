import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { AppDeps } from './deps.js';
import { registerErrorHandler } from './http/errors.js';
import { contentRoutes } from './routes/content.js';
import { federatedRoutes } from './routes/federated.js';
import { feedRoutes } from './routes/feed.js';
import { likeRoutes } from './routes/like.js';
import { registerRoutes } from './routes/register.js';
import { storeRoutes } from './routes/store.js';
import { tagRoutes } from './routes/tags.js';

export async function buildApp(deps: AppDeps, opts: FastifyServerOptions = {}) {
  const app = Fastify({ logger: { level: deps.config.logLevel }, ...opts });

  registerErrorHandler(app);
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
  contentRoutes(app, deps);
  feedRoutes(app, { config: deps.config, feedReader: deps.feedReader, summaries: deps.summaries, publishers: deps.publishers, now: deps.now });
  tagRoutes(app, deps);

  return app;
}
