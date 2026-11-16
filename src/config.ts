import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadLanguages, REFERENCE_LANGUAGE } from './language.js';
import { parseTagList } from './tags.js';

const int = (def: number) => z.coerce.number().int().positive().default(def);
const bool = (def: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(def);

/** The support address GET /rules gives on a server whose operator has set none (SUPPORT_EMAIL). */
export const DEFAULT_SUPPORT_EMAIL = 'noreply@yoururl.com';

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
   * address that registrations are limited by (`registerRateLimitPerHour`) and that the audit log
   * and the request log record: how many of them there are, true for any, or their addresses and
   * CIDR ranges (separated by commas or spaces). Empty: none, so the address is the connection's
   * own. A count is only safe where the server can't be reached except through those proxies:
   * anyone who connects directly chooses the address they are counted and recorded under.
   */
  trustProxy: z
    .union([z.boolean(), z.number().int().min(0), z.string()])
    .default('')
    .transform(parseTrustProxy),

  /** The RAM tier: feed index, summaries of the last few days, publisher credits. */
  redis: z.object({
    /** redis:// or rediss:// URL of any Redis-protocol server. Unset: an in-process store, for a single node only. */
    url: z.string().optional(),
    keyPrefix: z.string().default('tu:'),
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
   * Reposts (POST /repost): a user gives a post that is there more hashtags, which puts it in those
   * hashtags' feeds and in the following feeds of their own followers, as a new post there. The
   * post isn't copied: it stays the one piece of content it was, its publisher's.
   */
  reposts: z.object({
    /** Whether the server takes reposts at all. Off: POST /repost is refused, and what was reposted stays as it is. */
    enabled: bool(true),
    /**
     * Whether it takes reposts of posts on other servers. Such a repost is stored here as a link to
     * the original with the original's summary, which the reposter's client sends: this server asks
     * the other one nothing. Off: only posts on this server are reposted.
     */
    remote: bool(true),
  }),

  feed: z.object({
    /** Posts per feed page when the request doesn't pass `limit`. */
    pageSize: int(50),
    /** The largest `limit` a feed request may pass. */
    maxPageSize: int(100),
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
     * worked out from (covers clock skew between nodes), and the rows an update queued before it
     * wrote anything and hasn't committed (after this long, the update is taken to have stopped half way).
     */
    graceSeconds: z.coerce.number().int().min(0).default(30),
    /** Batches of indexes compacted at a time. A batch is a couple of hundred tags, read and written together. */
    concurrency: int(4),
    /**
     * Lifetime of the database lease that keeps the runs of two compactor processes from overlapping
     * (a deploy replacing one, a rebuild started by hand). A run renews it as it goes; a process that
     * stopped without releasing it delays the next run by up to this long. Keep it well above clock
     * skew between nodes and the slowest single storage write.
     */
    leaseSeconds: z.coerce.number().int().min(30).default(60),
  }),

  /**
   * Challenges people solve to register, to post again soon after posting, and to comment past a few
   * comments a minute. They're kept in Redis. Registering always takes one, which no setting turns
   * off: only an admin's request is spared it.
   */
  challenge: z.object({
    /**
     * A user's post (/store) less than this long after their previous post or challenge must
     * solve a challenge, or two from the third such post in a row (0: never).
     */
    postWindowSeconds: z.coerce.number().int().min(0).default(60),
    /**
     * A user's comment, or edit of one, past this many in any minute must solve a challenge, or two
     * from the third such comment in a row (0: never). `comments.perMinute` is where they stop.
     */
    commentsPerMinute: z.coerce.number().int().min(0).default(3),
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
   * Requests to /register from one address in an hour, past which they are refused. Every attempt
   * counts, an admin's included, so registering takes two: one for the challenge, one with its answer.
   * The address is the connection's own, or the one `trustProxy` has read from X-Forwarded-For.
   */
  registerRateLimitPerHour: int(10),
  /**
   * A user's posts (/store) in any minute past this many are refused outright, before any
   * challenge, however many challenges they'd solve (0: no limit).
   */
  postRateLimitPerMinute: z.coerce.number().int().min(0).default(3),
  /** The most users one user can follow. A following feed reads the index of every one of them. */
  maxFollowing: int(1000),
  /** Posts one user can report (POST /report) in an hour; each puts a post in the report queue (0: no limit). */
  reportsPerHour: z.coerce.number().int().min(0).default(20),

  /** Comments on posts, which each post's publisher turns on for it. They are objects in the content store, with Redis as a cache over them. */
  comments: z.object({
    /**
     * A user's comments in any minute past this many, edits of comments among them, are refused
     * outright, before any challenge, however many challenges they'd solve (0: no limit).
     */
    perMinute: z.coerce.number().int().min(0).default(10),
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
});

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
  POST_TYPE_TEXT: 'postTypes.text',
  POST_TYPE_IMAGE: 'postTypes.image',
  POST_TYPE_VIDEO: 'postTypes.video',
  POST_TYPE_AUDIO: 'postTypes.audio',
  POST_TYPE_LINK: 'postTypes.link',
  REPOSTS: 'reposts.enabled',
  REPOSTS_REMOTE: 'reposts.remote',
  FEED_PAGE_SIZE: 'feed.pageSize',
  FEED_MAX_PAGE_SIZE: 'feed.maxPageSize',
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
  COMPACT_LEASE_SECONDS: 'compact.leaseSeconds',
  CHALLENGE_POST_WINDOW_SECONDS: 'challenge.postWindowSeconds',
  CHALLENGE_COMMENTS_PER_MINUTE: 'challenge.commentsPerMinute',
  CHALLENGE_TTL_SECONDS: 'challenge.ttlSeconds',
  CHALLENGE_POW_BITS: 'challenge.powBits',
  CHALLENGE_MIN_SOLVE_MS: 'challenge.minSolveMs',
  TRUST_SCORE_DELETE_BELOW: 'trust.deleteBelow',
  TRUST_SCORE_ALLOW_FROM: 'trust.allowFrom',
  TRUST_OPTIONAL_PLUGINS: 'trust.optionalPlugins',
  URLHAUS_AUTH_KEY: 'urlhaus.authKey',
  URLHAUS_LIST_URL: 'urlhaus.listUrl',
  URLHAUS_REFRESH_MINUTES: 'urlhaus.refreshMinutes',
  REGISTER_RATE_LIMIT_PER_HOUR: 'registerRateLimitPerHour',
  POST_RATE_LIMIT_PER_MINUTE: 'postRateLimitPerMinute',
  MAX_FOLLOWING: 'maxFollowing',
  REPORTS_PER_HOUR: 'reportsPerHour',
  COMMENTS_PER_MINUTE: 'comments.perMinute',
  COMMENTS_HOT_HOURS: 'comments.hotHours',
  INBOX_MESSAGES_PER_MINUTE: 'inbox.messagesPerMinute',
  INBOX_RETENTION_DAYS: 'inbox.retentionDays',
  MONETIZATION_FEED_ADS: 'monetization.feedAds',
  MONETIZATION_POST_ADS: 'monetization.postAds',
};

const EMPTY_SECTIONS: Json = {
  db: {},
  redis: {},
  storage: { content: {}, summaries: {} },
  audit: {},
  tagging: {},
  postTypes: {},
  reposts: {},
  feed: {},
  compact: {},
  challenge: {},
  trust: {},
  urlhaus: {},
  comments: {},
  inbox: {},
  monetization: {},
};

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

  const merged = deepMerge(deepMerge(deepMerge(EMPTY_SECTIONS, fileConfig), envConfig), overrides);
  return ConfigSchema.parse(merged);
}
