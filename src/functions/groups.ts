import type { FastifyInstance } from 'fastify';
import type { RouteDeps, StoreDeps } from '../deps.js';
import { cliRoutes } from '../routes/cli.js';
import { commentReadRoutes, commentWriteRoutes } from '../routes/comments.js';
import { contentRoutes, deletionRoutes } from '../routes/content.js';
import { feedRoutes } from '../routes/feed.js';
import { followRoutes } from '../routes/follow.js';
import { inboxRoutes } from '../routes/inbox.js';
import { languageRoutes } from '../routes/languages.js';
import { likeRoutes } from '../routes/like.js';
import { moderationRoutes } from '../routes/moderation.js';
import { registerRoutes } from '../routes/register.js';
import { reportRoutes } from '../routes/reports.js';
import { storeRoutes } from '../routes/store.js';
import { tagRoutes } from '../routes/tags.js';
import { uploadRoutes } from '../routes/uploads.js';

interface WithDatabase {
  database: true;
  register(app: FastifyInstance, deps: RouteDeps): void;
}

/** A group that never opens the database, so its function starts without a connection. */
interface WithoutDatabase {
  database: false;
  register(app: FastifyInstance, deps: StoreDeps): void;
}

/**
 * The route groups, each of which can be served by a function of its own (see handler.ts): moving a
 * route to another group is a change to this table. The long-running server (src/server.ts) serves
 * them all. A deployment's gateway has to send each path to its group's function, so the routing
 * tables under deploy/terraform change with this one.
 *
 *   feed     GET /feed, /feed/following                       Redis and the summary store only
 *   content  GET /content/:id, /content/:id/raw,              one database read each, and the content store
 *            /content/:id/comments, /content/:id/comments/:id (and Redis, for comments)
 *   store    POST /uploads, /store                            writes posts
 *   api      everything else: register and users, languages, likes, follows, inboxes, messages
 *            and blocks, tags, moderation, reports, DELETE /content/:id, writing and deleting
 *            comments, and the CLI's download (/cli)
 */
export const GROUPS = {
  feed: {
    database: false,
    // Only what feeds read is passed on: they never touch the database.
    register: (app, { config, feedReader, authorReader, summaries, publishers, follows, relatedTags, now }) =>
      feedRoutes(app, { config, feedReader, authorReader, summaries, publishers, follows, relatedTags, now }),
  },
  content: {
    database: true,
    register(app, deps) {
      contentRoutes(app, deps);
      commentReadRoutes(app, deps);
    },
  },
  store: {
    database: true,
    register(app, deps) {
      uploadRoutes(app, deps);
      storeRoutes(app, deps);
    },
  },
  api: {
    database: true,
    register(app, deps) {
      registerRoutes(app, deps);
      languageRoutes(app);
      likeRoutes(app, deps);
      followRoutes(app, deps);
      inboxRoutes(app, deps);
      deletionRoutes(app, deps);
      commentWriteRoutes(app, deps);
      moderationRoutes(app, deps);
      reportRoutes(app, deps);
      tagRoutes(app, deps);
      cliRoutes(app, deps);
    },
  },
} satisfies Record<string, WithDatabase | WithoutDatabase>;

export type GroupName = keyof typeof GROUPS;
export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];
export const isGroup = (name: string | undefined): name is GroupName => name !== undefined && Object.hasOwn(GROUPS, name);
