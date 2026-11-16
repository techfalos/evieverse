import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parseTagList } from './tags.js';

export const TAGGING_MODES = ['server', 'user'] as const;
export type TaggingMode = (typeof TAGGING_MODES)[number];

const int = (def: number) => z.coerce.number().int().positive().default(def);
const bool = (def: boolean) =>
  z
    .preprocess(
      (v) => (typeof v === 'string' ? ['1', 'true', 'yes'].includes(v.toLowerCase()) : v),
      z.boolean(),
    )
    .default(def);

const ConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.coerce.number().int().default(3000),
  logLevel: z.string().default('info'),

  db: z.object({
    dialect: z.enum(['postgres', 'sqlite', 'mysql']).default('sqlite'),
    /** Connection URL for postgres/mysql, or a file path (or ":memory:") for sqlite. */
    url: z.string().default('./data/theuniverse.sqlite'),
    poolSize: int(10),
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

  /** The RAM tier: feed index, tail lists, summaries of the last few days, publisher credits. */
  redis: z.object({
    /** redis:// or rediss:// URL of any Redis-protocol server. Unset: an in-process store, for a single node only. */
    url: z.string().optional(),
    keyPrefix: z.string().default('tu:'),
  }),

  storage: z.object({
    /** Uploaded bytes and per-version metadata. Any Apache OpenDAL scheme (fs, s3, gcs, azblob, sftp, webdav, ...). */
    content: z.object({
      scheme: z.string().min(1).default('fs'),
      options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).default({ root: './data/content' }),
      signedUrlSeconds: int(900),
    }),
    /** Brotli-compressed summaries for the whole retention period. Any OpenDAL scheme; unset uses the content store. */
    summaries: z.object({
      scheme: z.string().min(1).optional(),
      options: z.preprocess(parseJson, z.record(z.string(), z.coerce.string())).optional(),
    }),
    tmpPath: z.string().optional(),
    maxUploadBytes: int(5 * 1024 * 1024 * 1024),
  }),

  /** Who chooses the hashtags of a post. */
  tagging: z
    .object({
      /** server: every post gets serverTags, whatever its publisher sends. user: the publisher's, which every post must have. */
      mode: z.enum(TAGGING_MODES).default('user'),
      /** The hashtags of every post in server mode (separated by commas or spaces in the environment). */
      serverTags: z
        .union([z.string(), z.array(z.string())])
        .default([])
        .transform((v, ctx) => {
          const parsed = parseTagList(v);
          if ('tags' in parsed) return parsed.tags;
          ctx.addIssue({ code: 'custom', message: parsed.error });
          return z.NEVER;
        }),
    })
    .refine((t) => t.mode !== 'server' || t.serverTags.length > 0, {
      path: ['serverTags'],
      message: 'server tagging needs at least one hashtag in TAGGING_SERVER_TAGS',
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
    maxLookbackDays: z.coerce.number().int().min(7).default(90),
    /** In the newest day slice, one in this many picks per tag is new low-like content (0 disables). */
    freshEvery: z.coerce.number().int().min(0).default(4),
    /** Records with at most this many likes count as fresh. */
    freshMaxLikes: z.coerce.number().int().min(0).default(0),
    /** Fresh picks are sampled per feed session from this many newest eligible records per tag. */
    freshPool: int(200),
    /** Words of a text post or caption copied into each record's preview... */
    previewWords: int(100),
    /** ...and at most this many characters of them, which bounds text written without spaces. */
    previewChars: int(1000),
    /** New records go to one Redis list per tag per window; closed windows are merged by the compactor. */
    tailWindowSeconds: int(300),
    /** Superseded day indexes, manifests and merged tails are kept this long, which is also the cursor lifetime. */
    genRetentionMinutes: int(60),
    /** How long a tag's head, tail-window list and publisher credits are cached by each node. */
    headCacheMs: z.coerce.number().int().min(0).default(1000),
    /** Tags whose manifest and day indexes (immutable; ~30 bytes per post) each node keeps in memory. */
    indexCacheSize: int(500),
    /** The same for publishers' own indexes, which following feeds read: one per user followed. */
    authorIndexCacheSize: int(5000),
    /** Summaries of posts younger than this are also kept in Redis; older ones are read from the summary store. */
    summaryHotDays: int(8),
    /** Brotli quality (0-11) of stored summaries. */
    summaryBrotliQuality: z.coerce.number().int().min(0).max(11).default(11),
    /** Compressed summaries read from the summary store that each node keeps in memory (they never change). */
    summaryCacheSize: z.coerce.number().int().min(0).default(20_000),
  }).refine((f) => f.pageSize <= f.maxPageSize, {
    path: ['pageSize'],
    message: 'FEED_PAGE_SIZE can be at most FEED_MAX_PAGE_SIZE',
  }),

  compact: z.object({
    /** Run the compactor inside the API process. Enable on one node (or run `npm run compact`); runs elsewhere would only skip. */
    inProcess: bool(true),
    intervalSeconds: int(60),
    /** Tail windows are merged only once they closed at least this long ago (covers clock skew between nodes). */
    graceSeconds: z.coerce.number().int().min(0).default(30),
    concurrency: int(4),
    /**
     * Lifetime of the database lease that keeps compactor runs from overlapping. A run renews it as it goes;
     * a run that stopped without releasing it delays the next one by up to this long. Keep it well above
     * clock skew between nodes and the slowest single storage write.
     */
    leaseSeconds: z.coerce.number().int().min(30).default(300),
  }),

  federation: z.object({
    /** /store waits this long for each server it federates content to. */
    timeoutMs: int(10_000),
  }),

  /** Challenges people solve to register, and to post again soon after posting. They're kept in Redis. */
  challenge: z.object({
    /** /register answers with a challenge, which the same request, sent again, must solve. */
    register: bool(true),
    /**
     * A user's post (/store or /federated) less than this long after their previous post or challenge must
     * solve challenges, more of them the longer the run (0: never).
     */
    postWindowSeconds: z.coerce.number().int().min(0).default(60),
    /** How long a challenge can be solved for. */
    ttlSeconds: int(120),
    /** Zero bits the proof of work's SHA-256 must start with; each doubles the client's work (0: none). */
    powBits: z.coerce.number().int().min(0).max(32).default(18),
    /** Answers sent sooner than this after the challenge was issued are refused: nobody reads and types it that fast. */
    minSolveMs: z.coerce.number().int().min(0).default(2000),
  }),

  registerRateLimitPerHour: int(10),
  /**
   * A user's posts (/store and /federated) in any minute past this many are refused outright, before any
   * challenge, however many challenges they'd solve (0: no limit).
   */
  postRateLimitPerMinute: z.coerce.number().int().min(0).default(3),
  /** The most users one user can follow. A following feed reads the index of every one of them. */
  maxFollowing: int(1000),
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
  DB_DIALECT: 'db.dialect',
  DATABASE_URL: 'db.url',
  DB_POOL_SIZE: 'db.poolSize',
  PUBLIC_BASE_URL: 'publicBaseUrl',
  CORS_ORIGINS: 'corsOrigins',
  REDIS_URL: 'redis.url',
  REDIS_KEY_PREFIX: 'redis.keyPrefix',
  CONTENT_SCHEME: 'storage.content.scheme',
  CONTENT_OPTIONS: 'storage.content.options',
  CONTENT_SIGNED_URL_SECONDS: 'storage.content.signedUrlSeconds',
  SUMMARY_SCHEME: 'storage.summaries.scheme',
  SUMMARY_OPTIONS: 'storage.summaries.options',
  STORAGE_TMP_PATH: 'storage.tmpPath',
  MAX_UPLOAD_BYTES: 'storage.maxUploadBytes',
  TAGGING_MODE: 'tagging.mode',
  TAGGING_SERVER_TAGS: 'tagging.serverTags',
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
  FEED_TAIL_WINDOW_SECONDS: 'feed.tailWindowSeconds',
  FEED_GEN_RETENTION_MINUTES: 'feed.genRetentionMinutes',
  FEED_HEAD_CACHE_MS: 'feed.headCacheMs',
  FEED_INDEX_CACHE_SIZE: 'feed.indexCacheSize',
  FEED_AUTHOR_CACHE_SIZE: 'feed.authorIndexCacheSize',
  SUMMARY_HOT_DAYS: 'feed.summaryHotDays',
  SUMMARY_BROTLI_QUALITY: 'feed.summaryBrotliQuality',
  SUMMARY_CACHE_SIZE: 'feed.summaryCacheSize',
  COMPACT_IN_PROCESS: 'compact.inProcess',
  COMPACT_INTERVAL_SECONDS: 'compact.intervalSeconds',
  COMPACT_GRACE_SECONDS: 'compact.graceSeconds',
  COMPACT_CONCURRENCY: 'compact.concurrency',
  COMPACT_LEASE_SECONDS: 'compact.leaseSeconds',
  FEDERATION_TIMEOUT_MS: 'federation.timeoutMs',
  CHALLENGE_REGISTER: 'challenge.register',
  CHALLENGE_POST_WINDOW_SECONDS: 'challenge.postWindowSeconds',
  CHALLENGE_TTL_SECONDS: 'challenge.ttlSeconds',
  CHALLENGE_POW_BITS: 'challenge.powBits',
  CHALLENGE_MIN_SOLVE_MS: 'challenge.minSolveMs',
  REGISTER_RATE_LIMIT_PER_HOUR: 'registerRateLimitPerHour',
  POST_RATE_LIMIT_PER_MINUTE: 'postRateLimitPerMinute',
  MAX_FOLLOWING: 'maxFollowing',
};

const EMPTY_SECTIONS: Json = {
  db: {},
  redis: {},
  storage: { content: {}, summaries: {} },
  tagging: {},
  feed: {},
  compact: {},
  federation: {},
  challenge: {},
};

function parseJson(v: unknown) {
  return typeof v === 'string' ? JSON.parse(v) : v;
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
 * (THEUNIVERSE_CONFIG or ./theuniverse.config.json), environment variables, and overrides.
 */
export function loadConfig(
  overrides: Json = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const filePath = resolve(env.THEUNIVERSE_CONFIG ?? 'theuniverse.config.json');
  let fileConfig: Json = {};
  if (existsSync(filePath)) fileConfig = JSON.parse(readFileSync(filePath, 'utf8')) as Json;

  const envConfig: Json = {};
  for (const [envKey, path] of Object.entries(ENV_MAP)) setPath(envConfig, path, env[envKey]);

  const merged = deepMerge(deepMerge(deepMerge(EMPTY_SECTIONS, fileConfig), envConfig), overrides);
  return ConfigSchema.parse(merged);
}
