import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { seedOf } from './attestation.js';
import { loadLanguages, REFERENCE_LANGUAGE } from './language.js';
import { parseTagList } from './tags.js';

/** The support address GET /rules gives on a server whose operator has set none (SUPPORT_EMAIL). */
export const DEFAULT_SUPPORT_EMAIL = 'noreply@yoururl.com';

/**
 * Which setting each environment variable sets, as the path of the setting's keys in the
 * configuration (`db.poolSize`). A variable that is unset or empty sets nothing (see setPath).
 */
const ENV_MAP: Record<string, string> = {
  HOST: 'host',
  PORT: 'port',
  LOG_LEVEL: 'logLevel',
  DEFAULT_LANGUAGE: 'defaultLanguage',
  EVIEVERSE_MODIFIED: 'modified',
  EVIEVERSE_SOURCE_URL: 'sourceUrl',
  SUPPORT_EMAIL: 'supportEmail',
  DB_DIALECT: 'db.dialect',
  DATABASE_URL: 'db.url',
  DB_POOL_SIZE: 'db.poolSize',
  DB_IDLE_TIMEOUT_MS: 'db.idleTimeoutMs',
  DB_MIGRATE_ON_START: 'db.migrateOnStart',
  PUBLIC_BASE_URL: 'publicBaseUrl',
  CORS_ORIGINS: 'corsOrigins',
  TRUST_PROXY: 'trustProxy',
  REDIS_URL: 'redis.url',
  REDIS_KEY_PREFIX: 'redis.keyPrefix',
  CONTENT_SCHEME: 'storage.content.scheme',
  CONTENT_OPTIONS: 'storage.content.options',
  CONTENT_SIGNED_URL_SECONDS: 'storage.content.signedUrlSeconds',
  SUMMARY_SCHEME: 'storage.summaries.scheme',
  SUMMARY_OPTIONS: 'storage.summaries.options',
  STORAGE_TMP_PATH: 'storage.tmpPath',
  MAX_UPLOAD_BYTES: 'storage.maxUploadBytes',
  UPLOAD_LINKS_PER_MINUTE: 'storage.uploadLinksPerMinute',
  AUDIT_SCHEME: 'audit.scheme',
  AUDIT_OPTIONS: 'audit.options',
  TAGGING_MODE: 'tagging.mode',
  TAGGING_SERVER_TAGS: 'tagging.serverTags',
  TAG_CLAIM_REVIEW_HOURS: 'tagging.claimReviewHours',
  TAG_CLAIMS_PER_DAY: 'tagging.claimsPerDay',
  TAG_MODERATOR_INACTIVE_DAYS: 'tagging.moderatorInactiveDays',
  TAG_LOG_RATE_LIMIT_PER_MINUTE: 'tagging.logRateLimitPerMinute',
  POST_TYPE_TEXT: 'postTypes.text',
  POST_TYPE_IMAGE: 'postTypes.image',
  POST_TYPE_VIDEO: 'postTypes.video',
  POST_TYPE_AUDIO: 'postTypes.audio',
  POST_TYPE_LINK: 'postTypes.link',
  VIDEO_PROCESSING: 'video.processing',
  VIDEO_HEIGHTS: 'video.heights',
  VIDEO_COMMENT_HEIGHT: 'video.commentHeight',
  VIDEO_TIMEOUT_SECONDS: 'video.timeoutSeconds',
  VIDEO_FFMPEG_PATH: 'video.ffmpegPath',
  VIDEO_FFPROBE_PATH: 'video.ffprobePath',
  REPOSTS: 'reposts.enabled',
  REPOSTS_REMOTE: 'reposts.remote',
  REPOSTS_SIGNING_KEYS: 'reposts.signingKeys',
  REPOSTS_ATTESTATION_RATE_LIMIT_PER_MINUTE: 'reposts.attestationRateLimitPerMinute',
  REPOSTS_REFRESH_HOURS: 'reposts.refreshHours',
  REPOSTS_GONE_DAYS: 'reposts.goneDays',
  CONTENT_RATE_LIMIT_PER_MINUTE: 'contentRateLimitPerMinute',
  PROFILE_POSTS_RATE_LIMIT_PER_MINUTE: 'profilePostsRateLimitPerMinute',
  AVATAR_RATE_LIMIT_PER_MINUTE: 'avatarRateLimitPerMinute',
  FEED_PAGE_SIZE: 'feed.pageSize',
  FEED_MAX_PAGE_SIZE: 'feed.maxPageSize',
  FEED_RATE_LIMIT_PER_MINUTE: 'feed.rateLimitPerMinute',
  FEED_FOLLOWING_RATE_LIMIT_PER_MINUTE: 'feed.followingRateLimitPerMinute',
  FEED_MAX_CONCURRENT: 'feed.maxConcurrent',
  FEED_TAG_DAY_MAX_POSTS: 'feed.tagDayMaxPosts',
  FEED_TAG_DAY_MIN_POSTS: 'feed.tagDayMinPosts',
  FEED_TAG_RETENTION_DAYS: 'feed.tagRetentionDays',
  FEED_AUTHOR_DAY_MAX_POSTS: 'feed.authorDayMaxPosts',
  FEED_MAX_LOOKBACK_DAYS: 'feed.maxLookbackDays',
  FEED_PREVIEW_WORDS: 'feed.previewWords',
  FEED_PREVIEW_CHARS: 'feed.previewChars',
  FEED_FRESH_EVERY: 'feed.freshEvery',
  FEED_FRESH_MAX_LIKES: 'feed.freshMaxLikes',
  FEED_FRESH_POOL: 'feed.freshPool',
  FEED_RELATED_TAGS: 'feed.relatedTags',
  FEED_RELATED_MIN_POSTS: 'feed.relatedMinPosts',
  FEED_RELATED_MIN_PERCENT: 'feed.relatedMinPercent',
  FEED_HEAD_CACHE_MS: 'feed.headCacheMs',
  FEED_INDEX_CACHE_SIZE: 'feed.indexCacheSize',
  FEED_AUTHOR_CACHE_SIZE: 'feed.authorIndexCacheSize',
  SUMMARY_HOT_DAYS: 'feed.summaryHotDays',
  SUMMARY_BROTLI_QUALITY: 'feed.summaryBrotliQuality',
  SUMMARY_CACHE_SIZE: 'feed.summaryCacheSize',
  SUMMARY_CACHE_SECONDS: 'feed.summaryCacheSeconds',
  COMPACT_IN_PROCESS: 'compact.inProcess',
  COMPACT_INTERVAL_SECONDS: 'compact.intervalSeconds',
  COMPACT_GRACE_SECONDS: 'compact.graceSeconds',
  COMPACT_CONCURRENCY: 'compact.concurrency',
  COMPACT_COMMENT_WRITES: 'compact.commentWrites',
  COMPACT_LEASE_SECONDS: 'compact.leaseSeconds',
  CHALLENGE_TTL_SECONDS: 'challenge.ttlSeconds',
  CHALLENGE_POW_BITS: 'challenge.powBits',
  CHALLENGE_MIN_SOLVE_MS: 'challenge.minSolveMs',
  TRUST_SCORE_DELETE_BELOW: 'trust.deleteBelow',
  TRUST_SCORE_ALLOW_FROM: 'trust.allowFrom',
  TRUST_OPTIONAL_PLUGINS: 'trust.optionalPlugins',
  URLHAUS_AUTH_KEY: 'urlhaus.authKey',
  URLHAUS_LIST_URL: 'urlhaus.listUrl',
  URLHAUS_REFRESH_MINUTES: 'urlhaus.refreshMinutes',
  PDQ_HASH_LIST: 'pdq.hashList',
  PDQ_HASH_LIST_AUTHORIZATION: 'pdq.authorization',
  PDQ_MAX_DISTANCE: 'pdq.maxDistance',
  PDQ_MIN_QUALITY: 'pdq.minQuality',
  PDQ_REFRESH_MINUTES: 'pdq.refreshMinutes',
  QUARANTINE_SCHEME: 'quarantine.scheme',
  QUARANTINE_OPTIONS: 'quarantine.options',
  QUARANTINE_RETENTION_DAYS: 'quarantine.retentionDays',
  REGISTER_RATE_LIMIT_PER_HOUR: 'registerRateLimitPerHour',
  POST_RATE_LIMIT_PER_MINUTE: 'postRateLimitPerMinute',
  MAX_FOLLOWING: 'maxFollowing',
  REPORTS_PER_HOUR: 'reportsPerHour',
  COMMENTS_PER_MINUTE: 'comments.perMinute',
  COMMENTS_LIST_RATE_LIMIT_PER_MINUTE: 'comments.listRateLimitPerMinute',
  COMMENTS_HOT_HOURS: 'comments.hotHours',
  INBOX_MESSAGES_PER_MINUTE: 'inbox.messagesPerMinute',
  INBOX_RETENTION_DAYS: 'inbox.retentionDays',
  EXPORT_PAGES_PER_MINUTE: 'export.pagesPerMinute',
  SEARCH_RATE_LIMIT_PER_MINUTE: 'search.rateLimitPerMinute',
  SEARCH_MAX_KEYWORDS: 'search.maxKeywords',
  MONETIZATION_FEED_ADS: 'monetization.feedAds',
  MONETIZATION_POST_ADS: 'monetization.postAds',
};

/**
 * Every section of the configuration, empty: what the file, the environment and the overrides are
 * merged over. A section none of them names is then still an object, which the schema fills with
 * its defaults; it refuses one that is missing.
 */
const EMPTY_SECTIONS: Json = {
  db: {},
  redis: {},
  storage: { content: {}, summaries: {} },
  audit: {},
  tagging: {},
  postTypes: {},
  video: {},
  reposts: {},
  feed: {},
  compact: {},
  challenge: {},
  trust: {},
  urlhaus: {},
  pdq: {},
  quarantine: {},
  comments: {},
  inbox: {},
  export: {},
  search: {},
  monetization: {},
};

/** A setting that is a whole number above zero, given as a number or as the string the environment has it in; `def` where it isn't set. */
const int = (def: number) => z.coerce.number().int().positive().default(def);
/**
 * A setting that is on or off; `def` where it isn't set. Of a string, as the environment has it,
 * "1", "true" and "yes" are on, in any case, and anything else is off.
 */
const bool = (def: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(def);

/**
 * Every setting of the server: its type, its default, and the values it refuses. `loadConfig`
 * parses what the file, the environment and the overrides say with it, and `Config` is what
 * comes out.
 */
const ConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().default(3000),
  logLevel: z.string().default('info'),

  /**
   * The code of the language the server answers in when a request asks for none it speaks, and that
   * users register in when they choose none: one of the files of the languages folder, such as en.
   */
  defaultLanguage: z.string().trim().min(1).default(REFERENCE_LANGUAGE),

  /**
   * The modification disclosure, which GET /rules gives to anyone who asks, beside the rules: that
   * this instance runs a modified version of Evieverse, one whose source code differs from a
   * release, as the additional terms Evieverse is licensed under define it. Those terms have a
   * modified version say so, and this is the supported way. It is the operator's own statement,
   * which the server checks against nothing.
   */
  modified: bool(false),
  /**
   * Where the source code this instance runs can be obtained: an http or https address. A modified
   * version has to say, so the server doesn't start as one without it. Unset: none is given.
   */
  sourceUrl: z
    .string()
    .trim()
    .nullable()
    .default(null)
    .transform((v, ctx) => {
      if (!v) return null;
      if (URL.canParse(v) && ['http:', 'https:'].includes(new URL(v).protocol)) return v;
      ctx.addIssue({ code: 'custom', message: `"${v}" is not an address such as https://example.com/evieverse-source: EVIEVERSE_SOURCE_URL is an http or https URL` });
      return z.NEVER;
    }),

  /**
   * The address people write to for support, which GET /rules gives to anyone who asks, beside the
   * rules. The server sends it nothing and checks only that it reads as an email address: the
   * default is a placeholder, for the operator to replace with an address that someone reads.
   */
  supportEmail: z
    .string()
    .trim()
    .default(DEFAULT_SUPPORT_EMAIL)
    .transform((v, ctx) => {
      if (!v) return DEFAULT_SUPPORT_EMAIL;
      if (z.email().safeParse(v).success) return v;
      ctx.addIssue({ code: 'custom', message: `"${v}" is not an email address such as support@example.com: SUPPORT_EMAIL is the address people write to for support` });
      return z.NEVER;
    }),

  db: z.object({
    dialect: z.enum(['postgres', 'sqlite', 'mysql']).default('sqlite'),
    /** Connection URL for postgres/mysql, or a file path (or ":memory:") for sqlite. */
    url: z.string().default('./data/evieverse.sqlite'),
    poolSize: int(10),
    /** Connections idle this long are closed (postgres, mysql). Unset: the driver's default. */
    idleTimeoutMs: z.coerce.number().int().positive().optional(),
    /** Bring the schema up to date whenever a process opens the database. Functions don't: their deploy runs `npm run migrate`. */
    migrateOnStart: bool(true),
  }),

  /** Absolute base URL used for media links in feed records, e.g. https://api.example.com. Empty = relative links. */
  publicBaseUrl: z.string().default(''),

  /**
   * Origins whose pages may call the API from a browser, e.g. https://app.example.com, or * for any
   * (separated by commas or spaces in the environment). Empty: none, so only pages on the API's own origin can.
   */
  corsOrigins: z
    .union([z.string(), z.array(z.string())])
    .default([])
    .transform((v, ctx) => {
      const parsed = parseOriginList(v);
      if ('origins' in parsed) return parsed.origins;
      ctx.addIssue({ code: 'custom', message: parsed.error });
      return z.NEVER;
    }),

  /**
   * The proxies in front of the server whose X-Forwarded-For is believed, which decides the client
   * address that registrations, feeds and the reads that need no key are limited by
   * (`registerRateLimitPerHour`, `feed.rateLimitPerMinute`, `feed.followingRateLimitPerMinute`,
   * `contentRateLimitPerMinute`, `profilePostsRateLimitPerMinute`, `avatarRateLimitPerMinute`, `comments.listRateLimitPerMinute`,
   * `reposts.attestationRateLimitPerMinute`, `tagging.logRateLimitPerMinute`) and that the audit log
   * and the request log record: how many of them there are, true for any, or their addresses and
   * CIDR ranges (separated by commas or spaces). Empty: none, so the address is the connection's
   * own. A count is only safe where the server can't be reached except through those proxies:
   * anyone who connects directly chooses the address they are counted and recorded under. And
   * a count that is too low has every reader counted as the last proxy it leaves out, so that
   * they all share one address's limits (see warnOfUncountedProxies).
   */
  trustProxy: z
    .union([z.boolean(), z.number().int().min(0), z.string()])
    .default('')
    .transform(parseTrustProxy),

  /** The RAM tier: feed index, summaries of the last few days, publisher credits. */
  redis: z.object({
    /** redis:// or rediss:// URL of any Redis-protocol server. Unset: an in-process store, for a single node only. */
    url: z.string().optional(),
    /**
     * Put in front of every key, so instances can share a Redis. It was `tu:` before: a
     * deployment that leaves it unset reads an empty index after this change, until the index is
     * rebuilt (`npm run compact -- --rebuild --once`), unless it sets REDIS_KEY_PREFIX=tu: to
     * keep the keys it has.
     */
    keyPrefix: z.string().default('ev:'),
  }),

  storage: z.object({
    /** Uploaded bytes and each post's meta file. Any Apache OpenDAL scheme (fs, s3, gcs, azblob, sftp, webdav, ...). */
    content: z.object({
      scheme: z.string().min(1).default('fs'),
      options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).default({ root: './data/content' }),
      /** Lifetime of the presigned links to stored bytes, and of the links POST /uploads gives to upload a file with. */
      signedUrlSeconds: int(900),
    }),
    /** Brotli-compressed summaries for the whole retention period. Any OpenDAL scheme; unset uses the content store. */
    summaries: z.object({
      scheme: z.string().min(1).optional(),
      options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).optional(),
    }),
    tmpPath: z.string().optional(),
    maxUploadBytes: int(5 * 1024 * 1024 * 1024),
    /** Upload links (POST /uploads) one user can ask for in a minute; each lets them put a file in the content store. 0: no limit. */
    uploadLinksPerMinute: z.coerce.number().int().min(0).default(10),
  }),

  /**
   * The audit log: every request that adds, updates or deletes something (a POST, PUT, PATCH or DELETE
   * that succeeded), whole, gzipped, one object each, and no read. A deployment's store is the
   * bucket that its lifecycle rules move to cold storage. Unset: nothing is written.
   */
  audit: z.object({
    /** Any Apache OpenDAL scheme (fs, s3, gcs, azblob ...). */
    scheme: z.string().min(1).optional(),
    options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).optional(),
  }),

  /** Which hashtags a post can have. Its publisher chooses them, and every post must have some. */
  tagging: z
    .object({
      /** user: any hashtags. server: only those of serverTags; a post with any other is refused. */
      mode: z.enum(['server', 'user']).default('user'),
      /**
       * The hashtags posts can have in server mode, as many as the server wants (separated by commas
       * or spaces in the environment). GET /tagging lists them, for clients to offer.
       */
      serverTags: z
        .union([z.string(), z.array(z.string())])
        .default([])
        .transform((v, ctx) => {
          // Any number of them: the limit on a post's hashtags is on what a publisher picks from these.
          const parsed = parseTagList(v, Infinity);
          if ('tags' in parsed) return parsed.tags;
          // Said to the operator as the server starts, so in English, whatever language requests are answered in.
          ctx.addIssue({ code: 'custom', message: loadLanguages().render(REFERENCE_LANGUAGE, parsed.error) });
          return z.NEVER;
        }),
      /**
       * In user mode, a user can claim a hashtag that has no moderator, to moderate it
       * (POST /tags/:tag/claim, src/moderation/claims.ts). The server's admins and server
       * moderators are told of the claim, and this is how long, in hours, any of them has to
       * refuse it: once it has passed, the compactor's next run makes the user a moderator of the
       * hashtag. 0: a claim is granted by the next run, and is an admin's to undo.
       */
      claimReviewHours: z.coerce.number().int().min(0).default(24),
      /** Hashtags one user can claim in a day; each claim leaves a notice with every admin and server moderator (0: no limit). */
      claimsPerDay: z.coerce.number().int().min(0).default(2),
      /**
       * Days a hashtag's moderator can go without doing anything as one on the hashtag before
       * they are its moderator no more (src/moderation/activity.ts): a year, unless told
       * otherwise. The compactor ends their time, and tells them. It goes for whoever has a row
       * for the hashtag, however they came to moderate it, and in either tagging mode; admins
       * and server moderators moderate every hashtag without one. 0: never.
       */
      moderatorInactiveDays: z.coerce.number().int().min(0).default(365),
      /**
       * Requests to GET /tags/:tag/log from one address in a minute, past which they are refused
       * (0: no limit). A hashtag's log needs no key, and a page of it reads the database.
       * Counted as feeds are (`feed.rateLimitPerMinute`), whichever hashtags' logs they ask for.
       */
      logRateLimitPerMinute: z.coerce.number().int().min(0).default(120),
    })
    .refine((t) => t.mode !== 'server' || t.serverTags.length > 0, {
      path: ['serverTags'],
      message: 'server tagging needs at least one hashtag in TAGGING_SERVER_TAGS',
    }),

  /**
   * Which types of post the server takes (POST_TYPES in src/posts.ts): all five unless turned off,
   * and at least one. A type that is off takes no new post and no update of one, and POST /uploads
   * gives no link for its files. The posts of it the server already holds stay as they are, to
   * read, like and delete.
   *
   * A comment comes with an image or a video only where posts of that type are taken: a server
   * that takes no video takes none with a comment either. A comment's text is no text post, so
   * comments are written whether text posts are on or off.
   */
  postTypes: z
    .object({ text: bool(true), image: bool(true), video: bool(true), audio: bool(true), link: bool(true) })
    .refine((types) => Object.values(types).some(Boolean), {
      message: 'the server needs a type of post to take: POST_TYPE_TEXT, POST_TYPE_IMAGE, POST_TYPE_VIDEO, POST_TYPE_AUDIO and POST_TYPE_LINK are all off',
    }),

  /**
   * What the server makes of the videos it is sent (src/video): of a video post's, and of the one
   * a comment comes with. A video is not published as it was sent. It is transcoded to H.264 and
   * AAC in MP4, which plays on any device, without the metadata its file came with (where and
   * when it was taken, on what), and a post's is also given a poster image and an adaptive stream
   * (HLS) at several sizes, so that a slow connection plays a small one. The post, or the
   * comment, is published once that is done: until then it says `processing`.
   *
   * The work is done with ffmpeg, by the video worker, which runs in the process that runs the
   * compactor (`npm run compact`, or the server's own with COMPACT_IN_PROCESS): that process
   * needs `ffmpeg` and `ffprobe`, which the Docker image has, and refuses to start without them
   * while this is on. Requests only mark a video to be processed, and need neither.
   */
  video: z.object({
    /**
     * Off: videos are stored and served as they were sent, metadata and all, as they were before
     * the server processed any. Every process of a deployment takes the same value: the ones that
     * serve requests mark the videos, and the compactor's processes them.
     */
    processing: bool(true),
    /**
     * The heights a post's video is made at, in pixels, as a list or as a string of them separated
     * by commas or spaces. Each is a rendition of the stream; the ones taller than the video are
     * left out, and a video shorter than the shortest is made at its own height. The MP4 that is
     * the post's bytes (`/raw`), which is what plays where the stream can't, is the tallest of
     * them that is no more than 720.
     */
    heights: z
      .preprocess(
        (v) => (typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v),
        z.array(z.coerce.number().int().min(144).max(2160)).min(1).max(8),
      )
      .default([1080, 720, 480, 240])
      .transform((heights) => [...new Set(heights)].sort((a, b) => b - a)),
    /** The most a comment's video measures in height, in pixels: it is one MP4, with no stream and no poster. */
    commentHeight: z.coerce.number().int().min(144).max(2160).default(720),
    /**
     * How long ffmpeg is given for one video, all of its renditions together, before it is
     * stopped and the video counts as one that can't be processed. Keep it above what the
     * longest video the server takes needs on the machine the worker runs on.
     */
    timeoutSeconds: int(3600),
    /** The `ffmpeg` to run: a path, or a name that is looked for on the PATH. */
    ffmpegPath: z.string().min(1).default('ffmpeg'),
    /** The `ffprobe` to run, likewise. */
    ffprobePath: z.string().min(1).default('ffprobe'),
  }),

  /**
   * Reposts (POST /repost): a user gives a post that is there more hashtags, which puts it in those
   * hashtags' feeds and in the following feeds of their own followers, as a new post there. The
   * post isn't copied: it stays the one piece of content it was, its publisher's.
   */
  reposts: z.object({
    /** Whether the server takes reposts at all. Off: POST /repost is refused, and what was reposted stays as it is. */
    enabled: bool(true),
    /**
     * Whether it takes reposts of posts on other servers. Such a repost is stored here as a link to
     * the original with the original's summary, as the original's server attested it: the
     * reposter's client sends the attestation, and this server asks the other one only for the
     * keys it signs with (src/attestation.ts). Off: only posts on this server are reposted.
     */
    remote: bool(true),
    /**
     * The keys this server signs the attestations of its posts with, which is what lets them be
     * reposted on other servers: each is 32 random bytes, in base64 or hex (`openssl rand -base64
     * 32`), separated by commas or spaces in the environment. The first signs. All are published
     * (GET /repost/keys), so a key is replaced by putting the new one first and taking the old one
     * out later. They are secrets: whoever has one signs as this server. Empty: the server
     * attests nothing, and its posts are reposted only here. It needs `publicBaseUrl` too, which
     * is where an attestation says a post is.
     */
    signingKeys: z
      .union([z.string(), z.array(z.string())])
      .default([])
      .transform((v, ctx) => {
        const keys = (typeof v === 'string' ? v.split(/[\s,]+/) : v).map((key) => key.trim()).filter(Boolean);
        if (keys.every((key) => seedOf(key) !== null)) return keys;
        // Which one, by its place: a key is never put in an error.
        ctx.addIssue({ code: 'custom', message: `key ${keys.findIndex((key) => seedOf(key) === null) + 1} of REPOSTS_SIGNING_KEYS is not 32 random bytes in base64 or hex, such as \`openssl rand -base64 32\` makes` });
        return z.NEVER;
      }),
    /**
     * Requests to GET /content/:id/attestation from one address in a minute, past which they are
     * refused (0: no limit). It needs no key, reads the database and signs an answer for any id,
     * one that was never a post's among them. Counted as feeds are (`feed.rateLimitPerMinute`).
     * Other servers ask it too, of the posts they hold reposts of (`refreshHours`): at most 30
     * times a minute each, so keep it above that.
     */
    attestationRateLimitPerMinute: z.coerce.number().int().min(0).default(60),
    /**
     * How often, in hours, the server asks the server of each post it holds a repost of for the
     * post's attestation again, which is how the repost follows an edit of the original, and is
     * hidden once the original is gone (0: never, so a repost changes only when a client brings
     * an attestation to POST /repost/refresh). The process that runs the compactor does the
     * asking, over https, a few posts a minute, so it needs to reach the other servers.
     */
    refreshHours: z.coerce.number().int().min(0).default(24),
    /**
     * Days a repost of a post on another server stays hidden after that server said it published
     * no post there, before the compactor deletes it. The other server says that of a post it
     * deleted and of one that only waits in its moderation queue, so the repost is kept this
     * long for the post to be attested again, which brings it back with what reposts gave it.
     */
    goneDays: int(7),
  }),

  /**
   * Requests to GET /content/:id from one address in a minute, past which they are refused (0: no
   * limit). It needs no key and reads the database and the content store for each. Counted as
   * feeds are (`feed.rateLimitPerMinute`).
   */
  contentRateLimitPerMinute: z.coerce.number().int().min(0).default(300),

  /**
   * Requests to GET /users/:userId/posts from one address in a minute, past which they are
   * refused (0: no limit). It lists a user's posts for their profile, needs no key, and reads the
   * database, the summary store and, for posts older than summaries are kept, the content store.
   * Counted as feeds are (`feed.rateLimitPerMinute`).
   */
  profilePostsRateLimitPerMinute: z.coerce.number().int().min(0).default(120),

  /**
   * Requests to GET /users/:userId/avatar from one address in a minute, past which they are
   * refused (0: no limit). It needs no key and reads the database and the content store for
   * each. A post read by its id and a profile each name one avatar, and what the address they
   * give answers is kept for a day, so this is what the posts of a minute can ask for. Counted
   * as feeds are (`feed.rateLimitPerMinute`).
   */
  avatarRateLimitPerMinute: z.coerce.number().int().min(0).default(300),

  feed: z.object({
    /** Posts per feed page when the request doesn't pass `limit`. */
    pageSize: int(50),
    /** The largest `limit` a feed request may pass. */
    maxPageSize: int(100),
    /**
     * Requests to GET /feed from one address in a minute, past which they are refused (0: no limit).
     * A feed needs no key, so the address is all there is to count by: the connection's own, or the
     * one `trustProxy` has read from X-Forwarded-For. An IPv6 address counts with the rest of its /64,
     * which is what one host is given.
     */
    rateLimitPerMinute: z.coerce.number().int().min(0).default(120),
    /**
     * The same for GET /feed/following, counted apart (0: no limit). A page of it costs more
     * than a hashtag feed's: it asks the database who may read it, and reads the index of every
     * user followed, up to `maxFollowing` of them. It needs no key where the user shows whom
     * they follow.
     */
    followingRateLimitPerMinute: z.coerce.number().int().min(0).default(60),
    /**
     * GET /feed requests one process answers at a time. One that arrives while this many are under
     * way is refused (503) rather than made to wait behind them, whatever addresses they come from:
     * what the limit by address can't stop, a flood from many of them, stops here (0: no limit).
     */
    maxConcurrent: z.coerce.number().int().min(0).default(100),
    /** Posts a tag's index keeps for today; each older UTC day keeps half the previous day's... */
    tagDayMaxPosts: int(400),
    /** ...but never fewer than this, so a day's most-liked content stays for the whole retention period. */
    tagDayMinPosts: int(40),
    /** UTC days a tag's index keeps, and summaries are stored (capped at maxLookbackDays). */
    tagRetentionDays: int(90),
    /** Posts a publisher's own index, which following feeds read, keeps per UTC day: the newest, whatever their likes. */
    authorDayMaxPosts: int(1000),
    /** How far back a following feed reaches, and the longest a tag's index is kept. A hashtag feed is of the window it asks for. */
    maxLookbackDays: z.coerce.number().int().min(7).default(90),
    /** In a popular feed, one in this many picks per tag is new low-like content (0 disables). */
    freshEvery: z.coerce.number().int().min(0).default(4),
    /** Records with at most this many likes count as fresh. */
    freshMaxLikes: z.coerce.number().int().min(0).default(0),
    /** Fresh picks are sampled per feed session from this many newest eligible records per tag in the feed's window. */
    freshPool: int(200),
    /** A feed asked to add related hashtags (addRelated) adds at most this many for each hashtag it was asked for (0: none). */
    relatedTags: z.coerce.number().int().min(0).default(3),
    /** A hashtag is related to another once at least this many posts carry both... */
    relatedMinPosts: int(5),
    /** ...and those are at least this share, in percent, of the posts that carry the other. */
    relatedMinPercent: z.coerce.number().int().min(0).max(100).default(20),
    /** Words of a text post or caption copied into each record's preview... */
    previewWords: int(100),
    /** ...and at most this many characters of them, which bounds text written without spaces. */
    previewChars: int(1000),
    /**
     * How long a tag's head and related hashtags, and publisher credits, are cached by each node. A
     * node shows what the compactor published up to this long after it did.
     */
    headCacheMs: z.coerce.number().int().min(0).default(1000),
    /** Tags whose manifest and day indexes (immutable; 25 bytes per post) each node keeps in memory. */
    indexCacheSize: int(500),
    /** The same for publishers' own indexes, which following feeds read: one per user followed. */
    authorIndexCacheSize: int(5000),
    /** Summaries of posts younger than this are also kept in Redis; older ones are read from the summary store. */
    summaryHotDays: int(8),
    /** Brotli quality (0-11) of stored summaries. */
    summaryBrotliQuality: z.coerce.number().int().min(0).max(11).default(11),
    /** Compressed summaries read from the summary store that each node keeps in memory... */
    summaryCacheSize: z.coerce.number().int().min(0).default(20_000),
    /** ...for this long, so a post older than summaryHotDays can show as it was for this long after an update (0: not kept). */
    summaryCacheSeconds: z.coerce.number().int().min(0).default(60),
  }).refine((f) => f.pageSize <= f.maxPageSize, {
    path: ['pageSize'],
    message: 'FEED_PAGE_SIZE can be at most FEED_MAX_PAGE_SIZE',
  }),

  compact: z.object({
    /** Run the compactor inside the API process. Enable on one node (or run `npm run compact`); runs elsewhere would only skip. */
    inProcess: bool(true),
    /**
     * The compactor is one process that runs for as long as it is up: a run starts this long after the
     * previous one started, or as soon as that one ends if it took longer. So runs never overlap, and
     * there is never more than one in this many seconds.
     *
     * It is also how long a write waits to reach feeds, at most: every run takes all of the feed queue.
     */
    intervalSeconds: int(5),
    /**
     * What a run leaves for a later one until it is this old: the hashtag counts related hashtags are
     * worked out from, which covers clock skew between nodes. A write waits for nothing: a run takes
     * every row of the feed queue and applies every pending write there is.
     */
    graceSeconds: z.coerce.number().int().min(0).default(30),
    /** Batches of indexes compacted at a time. A batch is a couple of hundred tags, read and written together. */
    concurrency: int(4),
    /**
     * Writes to comments a run has under way at once, on whatever posts: a comment's own write,
     * or one like of it. Beside them, a run writes the posts of `concurrency` posts at a time.
     */
    commentWrites: int(16),
    /**
     * Lifetime of the database lease that keeps the runs of two compactor processes from overlapping
     * (a deploy replacing one, a rebuild started by hand). It is renewed for as long as a run holds
     * it, by a timer and as the run goes, so a storage write can outlast it; a process that stopped
     * without releasing it delays the next run by up to this long. Keep it well above clock skew
     * between nodes, and above the longest the compactor's process may be frozen or cut off from
     * the database.
     */
    leaseSeconds: z.coerce.number().int().min(30).default(60),
  }),

  /**
   * The challenge people solve to register, which is kept in Redis. Registering always takes one,
   * which no setting turns off: only an admin's request is spared it. Nothing else takes one:
   * posts and comments are held to a limit a minute (`postRateLimitPerMinute`, `comments.perMinute`).
   */
  challenge: z.object({
    /** How long a challenge can be solved for. */
    ttlSeconds: int(120),
    /** Zero bits the proof of work's SHA-256 must start with; each doubles the client's work (0: none). */
    powBits: z.coerce.number().int().min(0).max(32).default(18),
    /** Answers sent sooner than this after the challenge was issued are refused: nobody reads and types it that fast. */
    minSolveMs: z.coerce.number().int().min(0).default(2000),
  }),

  /**
   * Where a post's trust score sends it. The score runs from 0 (not trusted at all) to 100, is worked
   * out for every post and update when it is sent, and is kept nowhere but in the moderation queue.
   */
  trust: z
    .object({
      /** A post that scores less than this is deleted on arrival: it is refused, and nothing of it is kept. 0: no post is. */
      deleteBelow: z.coerce.number().int().min(0).max(100).default(25),
      /** A post that scores at least this is published. One that scores less, and isn't deleted, waits in the moderation queue for an admin. 101: every post waits. */
      allowFrom: z.coerce.number().int().min(0).max(101).default(75),
      /**
       * The optional trust plugins the server runs, by the names of their folders in
       * src/plugins/trust (separated by commas or spaces in the environment), such as urlhaus. A
       * plugin that isn't optional runs whatever this says. Empty: no optional plugin runs.
       */
      optionalPlugins: z
        .union([z.string(), z.array(z.string())])
        .default([])
        .transform((v) => [...new Set((typeof v === 'string' ? v.split(/[\s,]+/) : v).map((name) => name.trim()).filter(Boolean))]),
    })
    .refine((t) => t.deleteBelow <= t.allowFrom, {
      path: ['deleteBelow'],
      message: 'TRUST_SCORE_DELETE_BELOW can be at most TRUST_SCORE_ALLOW_FROM',
    }),

  /**
   * The urlhaus trust plugin (src/plugins/trust/urlhaus), which gives a post or a comment with a
   * link that spreads malware a trust score of 0. It checks links against the list URLhaus
   * publishes (https://urlhaus.abuse.ch), which each process downloads and keeps in memory.
   * It is optional: these are read only where `trust.optionalPlugins` names urlhaus.
   */
  urlhaus: z.object({
    /** The Auth-Key the list is downloaded with: that of an abuse.ch account, which is free (https://auth.abuse.ch). A server that runs the plugin needs one. */
    authKey: z.string().trim().min(1).optional(),
    /**
     * Where the list is downloaded from, with {key} where the Auth-Key goes: one of URLhaus's
     * database dumps as a CSV, or its plain list of URLs. By default, the URLs added in the last 30 days.
     */
    listUrl: z
      .string()
      .trim()
      .refine((url) => /^https?:\/\//i.test(url) && URL.canParse(url.replaceAll('{key}', 'key')), {
        message: 'URLHAUS_LIST_URL is an http or https URL, with {key} where the Auth-Key goes',
      })
      .default('https://urlhaus-api.abuse.ch/v2/files/exports/{key}/recent.csv'),
    /** Minutes between two downloads of the list, by each process. URLhaus writes its lists every 5 minutes, and asks not to be asked more often. */
    refreshMinutes: z.coerce.number().int().min(5).default(15),
  }),

  /**
   * The pdq trust plugin (src/plugins/trust/pdq), which gives a post or a comment with an image
   * of known child sexual abuse material a trust score of 0, and tells the server's admins of it.
   * It matches each image's PDQ hash against a list of hashes of such material, which each
   * process reads and keeps in memory. It is optional: these are read only where
   * `trust.optionalPlugins` names pdq.
   */
  pdq: z.object({
    /**
     * Where the list of hashes is: the path of a file, or an http or https address it is
     * downloaded from. One PDQ hash a line, as 64 hex digits; a CSV or TSV with the hash in a
     * column is read too. A server that runs the plugin needs one. The list is the operator's to
     * get: the hashes aren't public, and are shared with the platforms that apply for them by
     * those who keep them (a hash-sharing programme, such as NCMEC's or Meta's ThreatExchange).
     */
    hashList: z.string().trim().min(1).optional(),
    /** The Authorization header a list at an address is asked for with, such as "Bearer <token>". Not used for a file. */
    authorization: z.string().trim().min(1).optional(),
    /**
     * The most bits, of a hash's 256, an image's hash can differ from a listed one in and still be
     * taken for the same picture. 31 is what PDQ's authors match at; lower finds fewer altered
     * copies, and higher takes more pictures for ones they aren't. 0: only the very same hash.
     */
    maxDistance: z.coerce.number().int().min(0).max(63).default(31),
    /**
     * The least quality, from 0 to 100, an image's hash must have to be matched: how much there
     * is in the picture to tell it by. A picture of one colour, or of a plain gradient, has a hash
     * near that of every other such picture, and would match by chance. 50 is what PDQ's authors use.
     */
    minQuality: z.coerce.number().int().min(0).max(100).default(50),
    /** Minutes between two readings of the list, by each process. A file that hasn't changed isn't read again. */
    refreshMinutes: z.coerce.number().int().min(1).default(60),
  }),

  /**
   * The quarantine (src/quarantine.ts): where the server keeps the files that matched the pdq
   * plugin's list, each as it was read, for the report the operator may have to make of it and
   * for as long as the law has a reported file kept afterwards. It is a store of its own, which
   * nothing else is written to and nothing is served from: only an admin reads a file of it,
   * through the API (/moderation/quarantine), and every such read is recorded. Unset: no file
   * that matched is kept, as before there was a quarantine.
   */
  quarantine: z.object({
    /**
     * Any Apache OpenDAL scheme (fs, s3, gcs, azblob ...). Not the content store, nor the summaries'
     * or the audit log's: a bucket or a folder that only the server's own processes reach, encrypted
     * and with its own access log where the provider has them.
     */
    scheme: z.string().min(1).optional(),
    options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).optional(),
    /**
     * Days a file is kept after an admin recorded that it was reported (POST
     * /moderation/quarantine/:id/report), counted from the time of the report: the compactor
     * deletes it once they have passed, once a day. A year is what United States law has a
     * provider keep what it reported to the CyberTipline for (18 U.S.C. 2258A(h)); the law
     * elsewhere may ask for another time. A file nobody reported is not deleted by this.
     */
    retentionDays: int(365),
  }),

  /**
   * Requests to /register from one address in an hour, past which they are refused. Every attempt
   * counts, an admin's included, so registering takes two: one for the challenge, one with its answer.
   * The address is the connection's own, or the one `trustProxy` has read from X-Forwarded-For.
   */
  registerRateLimitPerHour: int(10),
  /**
   * A user's posts (/store) in any minute past this many are refused, reposts and updates of
   * posts among them (0: no limit).
   */
  postRateLimitPerMinute: z.coerce.number().int().min(0).default(3),
  /** The most users one user can follow. A following feed reads the index of every one of them. */
  maxFollowing: int(1000),
  /** Posts one user can report (POST /report) in an hour; each puts a post in the report queue (0: no limit). */
  reportsPerHour: z.coerce.number().int().min(0).default(20),

  /** Comments on posts, which each post's publisher turns on for it. They are objects in the content store, with Redis as a cache over them. */
  comments: z.object({
    /** A user's comments in any minute past this many, edits of comments among them, are refused (0: no limit). */
    perMinute: z.coerce.number().int().min(0).default(10),
    /**
     * Requests from one address in a minute to each of the two lists of comments (GET
     * /content/:id/comments, and a comment's replies), past which they are refused (0: no
     * limit). They need no key, and a list of a post whose comments Redis doesn't hold is a
     * listing of the content store. Counted as feeds are (`feed.rateLimitPerMinute`).
     */
    listRateLimitPerMinute: z.coerce.number().int().min(0).default(120),
    /**
     * How long Redis keeps a post's index of its comments, each comment, and each comment's number
     * of likes, before they are read from the content store again: the index from one list of the
     * post's comments, and the number from one list of the comment's likes.
     */
    hotHours: int(24),
  }),

  /** Each user's inbox: the messages other users send them, and the server's notices about their posts and mutes. */
  inbox: z.object({
    /** Messages one user can send other users in a minute (0: no limit). */
    messagesPerMinute: z.coerce.number().int().min(0).default(10),
    /** Days a message or a notice stays in an inbox; the compactor deletes older ones, once a day. */
    retentionDays: int(90),
  }),

  /** A user's export of their own data (GET /users/:userId/export), which they read a page at a time. */
  export: z.object({
    /**
     * Pages of their export one user can read in a minute (0: no limit). A page is up to 1,000
     * records and about a megabyte, so this bounds what one account can have the database and the
     * content store read, and still lets a large account be exported in minutes.
     */
    pagesPerMinute: z.coerce.number().int().min(0).default(120),
  }),

  /** Search (GET /search): of users by the start of their username, and of posts by the words of their text and their hashtags. */
  search: z.object({
    /**
     * Requests to GET /search from one address in a minute, past which they get 429 (0: no
     * limit). It needs no key and reads the database for each. Counted as feeds are
     * (`feed.rateLimitPerMinute`).
     */
    rateLimitPerMinute: z.coerce.number().int().min(0).default(60),
    /**
     * The most words of its text or caption a post is found by: the most frequent ones, which are
     * the rows the compactor keeps for it in `search_terms`, beside one for each of its hashtags.
     * The compactor takes it, and so does `npm run reindex`, which is what makes a change of it
     * hold for the posts that are already there.
     */
    maxKeywords: int(100),
  }),

  /**
   * Where the server shows the ads its admins keep (/monetization/ads), each with the word
   * "Sponsored". Both are off unless turned on: a server that turns on neither shows no ad, whatever
   * ads it has. The compactor publishes the ads where either is on, so it takes the same settings.
   */
  monetization: z.object({
    /** Hashtag feeds (GET /feed) come with ads to show before the 3rd, 10th and 17th post of each page. */
    feedAds: bool(false),
    /** A post (GET /content/:contentId) comes with an ad to show at its end. */
    postAds: bool(false),
  }),
}).refine((c) => !c.modified || c.sourceUrl !== null, {
  path: ['sourceUrl'],
  message: 'EVIEVERSE_MODIFIED needs EVIEVERSE_SOURCE_URL: where the source code of this modified version can be obtained',
}).refine((c) => !c.trust.optionalPlugins.includes('urlhaus') || c.urlhaus.authKey !== undefined, {
  path: ['urlhaus', 'authKey'],
  message: 'TRUST_OPTIONAL_PLUGINS turns on urlhaus, which needs URLHAUS_AUTH_KEY: the Auth-Key of an abuse.ch account, which is free (https://auth.abuse.ch)',
}).refine((c) => !c.trust.optionalPlugins.includes('pdq') || c.pdq.hashList !== undefined, {
  path: ['pdq', 'hashList'],
  message: 'TRUST_OPTIONAL_PLUGINS turns on pdq, which needs PDQ_HASH_LIST: the file or the address of the list of PDQ hashes it matches images against',
}).refine((c) => !c.trust.optionalPlugins.includes('pdq') || c.trust.allowFrom > 0, {
  path: ['trust', 'allowFrom'],
  message: 'TRUST_OPTIONAL_PLUGINS turns on pdq, which needs TRUST_SCORE_ALLOW_FROM above 0: at 0 every post is published whatever its score, an image that matches the list too',
}).refine((c) => c.quarantine.scheme === undefined || sharedStore(c) === null, {
  path: ['quarantine', 'scheme'],
  message:
    'QUARANTINE_SCHEME and QUARANTINE_OPTIONS name a store that another setting names too (CONTENT_SCHEME, SUMMARY_SCHEME or AUDIT_SCHEME, with the same options): the quarantine needs a store of its own, which nothing else is read from or written to',
});

/** The settings that each name a store: what `sharedStore` compares the quarantine's with. */
type Stores = {
  storage: { content: Store; summaries: Partial<Store> };
  audit: Partial<Store>;
  quarantine: Partial<Store>;
};
/** A store as the settings name one: an OpenDAL scheme and its options. */
type Store = { scheme: string; options: Record<string, string> };

/** Where a store's options say it is, in one form: the options in the order of their names, with a path's trailing slashes left out. */
function placeOf({ scheme, options }: Partial<Store>): string {
  const entries = Object.entries(options ?? {})
    .map(([name, value]) => [name, value.replace(/\/+$/, '')])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  return JSON.stringify([scheme, entries]);
}

/**
 * The variable of the store that the quarantine's settings name too, or null if they name one of
 * their own. The same scheme with the same options is the same store: files that matched the
 * list would then lie among the posts' own, or in a log, where whatever reads those reads them.
 * It tells no more than that: a folder inside another store's, or a second name for one bucket,
 * is the operator's to avoid.
 */
function sharedStore({ storage, audit, quarantine }: Stores): string | null {
  const place = placeOf(quarantine);
  if (place === placeOf(storage.content)) return 'CONTENT_SCHEME';
  if (storage.summaries.scheme !== undefined && place === placeOf(storage.summaries)) return 'SUMMARY_SCHEME';
  if (audit.scheme !== undefined && place === placeOf(audit)) return 'AUDIT_SCHEME';
  return null;
}

export type Config = z.infer<typeof ConfigSchema>;

type Json = { [k: string]: unknown };

function setPath(target: Json, path: string, value: string | undefined) {
  if (value === undefined || value === '') return;
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Json;
  }
  node[keys[keys.length - 1]!] = value;
}

function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object'
        ? deepMerge(b as Json, v as Json)
        : v;
  }
  return out;
}

function parseJson(v: unknown) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

/** "" -> false; "true" -> true; "2" -> 2 proxies; "10.0.0.0/8, 127.0.0.1" -> those addresses. */
function parseTrustProxy(input: boolean | number | string): boolean | number | string[] {
  if (typeof input !== 'string') return input;
  const words = input.split(/[\s,]+/).filter(Boolean);
  const [only] = words;
  if (words.length === 0 || (words.length === 1 && only!.toLowerCase() === 'false')) return false;
  if (words.length === 1 && only!.toLowerCase() === 'true') return true;
  if (words.length === 1 && /^\d+$/.test(only!)) return Number(only);
  return words;
}

/** "https://a.example/, *" -> ["*"]; "https://a.example/ http://localhost:5173" -> the two origins. */
function parseOriginList(input: string | string[]): { origins: string[] } | { error: string } {
  const words = (typeof input === 'string' ? input.split(/[\s,]+/) : input).map((w) => w.trim()).filter(Boolean);
  if (words.includes('*')) return { origins: ['*'] };
  const origins = new Set<string>();
  for (const word of words) {
    let url: URL;
    try {
      url = new URL(word);
    } catch {
      return { error: `"${word}" is not an origin such as https://app.example.com` };
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return { error: `"${word}" is not an origin such as https://app.example.com: only a scheme, host and port` };
    }
    origins.add(url.origin);
  }
  return { origins: [...origins] };
}

/**
 * Loads config from (lowest to highest precedence): defaults, a JSON file
 * (EVIEVERSE_CONFIG or ./evieverse.config.json), environment variables, and overrides.
 */
export function loadConfig(
  overrides: Json = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const filePath = resolve(env.EVIEVERSE_CONFIG ?? 'evieverse.config.json');
  let fileConfig: Json = {};
  if (existsSync(filePath)) fileConfig = JSON.parse(readFileSync(filePath, 'utf8')) as Json;

  const envConfig: Json = {};
  for (const [envKey, path] of Object.entries(ENV_MAP)) setPath(envConfig, path, env[envKey]);

  return ConfigSchema.parse(deepMerge(deepMerge(deepMerge(EMPTY_SECTIONS, fileConfig), envConfig), overrides));
}
