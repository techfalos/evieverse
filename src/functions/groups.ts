import type { FastifyInstance } from 'fastify';
import type { RouteDeps, StoreDeps } from '../deps.types.js';
import { challengeRoutes } from '../routes/challenges.js';
import { cliRoutes } from '../routes/cli.js';
import { commentReadRoutes, commentWriteRoutes } from '../routes/comments.js';
import { contentRoutes, deletionRoutes } from '../routes/content.js';
import { feedRoutes, followingFeedRoutes } from '../routes/feed.js';
import { followRoutes } from '../routes/follow.js';
import { inboxRoutes } from '../routes/inbox.js';
import { languageRoutes } from '../routes/languages.js';
import { likeRoutes } from '../routes/like.js';
import { moderationRoutes } from '../routes/moderation.js';
import { monetizationRoutes } from '../routes/monetization.js';
import { registerRoutes } from '../routes/register.js';
import { reportRoutes } from '../routes/reports.js';
import { repostRoutes } from '../routes/reposts.js';
import { rulesRoutes } from '../routes/rules.js';
import { storeRoutes } from '../routes/store.js';
import { tagRoutes } from '../routes/tags.js';
import { uploadRoutes } from '../routes/uploads.js';

/** A group whose routes use the database: its function opens it as it starts, and an app that has none refuses to serve the group (`buildApp`). */
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
 *   feed     GET /feed                                        Redis and the summary store only
 *   content  GET /content/:id, /content/:id/raw,              one database read each, and the content store
 *            /content/:id/comments, /content/:id/comments/:id (and Redis, for comments)
 *            and /content/:id/comments/:id/replies, /raw,
 *            /content/:id/attestation (signed, for a repost on another server)
 *   store    POST /uploads, /store                            writes posts
 *   api      everything else: register and users, challenges read out (/challenges/:id/audio,
 *            whichever group issued them: they are in Redis), languages, likes (of posts and of comments),
 *            reposts (POST /repost, which writes database rows, and a link to the original for a
 *            post on another server, whose keys it asks that server for; POST /repost/refresh,
 *            which brings such a link up to what its original is now; GET /repost/keys, this
 *            server's own), follows and the following feed (GET /feed/following, which asks the database who may
 *            read it), inboxes, messages and blocks, tagging and tags, moderation, reports, the
 *            server's rules and its modification disclosure (/rules),
 *            DELETE /content/:id, writing, editing and deleting comments, the server's ads,
 *            their images and the links they are followed by (/monetization/ads), and the CLI's
 *            download (/cli)
 */
export const GROUPS = {
  feed: {
    database: false,
    // Only what hashtag feeds read is passed on: they never touch the database.
    register: (app, { config, feedReader, summaries, publishers, relatedTags, ads, now }) =>
      feedRoutes(app, { config, feedReader, summaries, publishers, relatedTags, ads, now }),
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
      challengeRoutes(app, deps);
      languageRoutes(app);
      likeRoutes(app, deps);
      repostRoutes(app, deps);
      followRoutes(app, deps);
      followingFeedRoutes(app, deps);
      inboxRoutes(app, deps);
      deletionRoutes(app, deps);
      commentWriteRoutes(app, deps);
      moderationRoutes(app, deps);
      monetizationRoutes(app, deps);
      reportRoutes(app, deps);
      rulesRoutes(app, deps);
      tagRoutes(app, deps);
      cliRoutes(app, deps);
    },
  },
} satisfies Record<string, WithDatabase | WithoutDatabase>;

export type GroupName = keyof typeof GROUPS;
/**
 * The names of the route groups, in the order of `GROUPS`: what an app serves unless it is told
 * which (`buildApp`), and what the check of a deployment's settings starts one by one
 * (`checkSettings`).
 */
export const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];
/** Whether `name` is a route group's: what an entry point holds FUNCTION_GROUP to, which may not be set at all. */
export const isGroup = (name: string | undefined): name is GroupName => name !== undefined && Object.hasOwn(GROUPS, name);
