import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runCompactor } from './rust.js';

/**
 * The compactor's binary reads the configuration on its own (compactor/crates/core/src/config.rs): the same
 * file and the same environment variables as the API (src/config.ts), for the settings it uses.
 * These tests give both the same and hold what the binary resolved to what the API resolved, and
 * what the binary refuses to what the API refuses.
 */
const dir = mkdtempSync(join(tmpdir(), 'evieverse-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A configuration file that is not there, so neither side reads the one of the folder the tests run in. */
const NO_FILE = join(dir, 'none.json');

type Env = Record<string, string>;
type Json = { [key: string]: unknown };

const HEX_KEY = '0123456789abcdef'.repeat(4);
const BASE64_KEY = 'q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=';

/** What a server that sets nothing else runs with. */
const DEFAULTS: Env = { REDIS_URL: 'redis://127.0.0.1:6379' };

/** Every variable the binary reads (ENV_MAP in compactor/crates/core/src/config.rs), each set to something other than its default (one type of post stays on: a server takes one). */
const EVERYTHING: Env = {
  LOG_LEVEL: 'debug',
  DB_DIALECT: 'postgres',
  DATABASE_URL: 'postgres://evie:db-secret@db.example:5432/evie',
  DB_POOL_SIZE: '7',
  DB_IDLE_TIMEOUT_MS: '30000',
  DB_MIGRATE_ON_START: 'false',
  PUBLIC_BASE_URL: 'https://api.example.com',
  REDIS_URL: ' rediss://:redis-secret@redis.example:6380/2 ',
  REDIS_KEY_PREFIX: 'evie:',
  CONTENT_SCHEME: 's3',
  CONTENT_OPTIONS: '{"bucket":"content","region":"eu-west-1","secret_access_key":"content-secret","port":9000,"tls":true}',
  CONTENT_SIGNED_URL_SECONDS: '600',
  SUMMARY_SCHEME: 'gcs',
  SUMMARY_OPTIONS: '{"bucket":"summaries","credential":"summary-secret"}',
  STORAGE_TMP_PATH: '/var/tmp/evie',
  TAGGING_MODE: 'server',
  // The API's own, which it needs with that mode: the binary reads the mode, and not the hashtags.
  TAGGING_SERVER_TAGS: 'news',
  TAG_MODERATOR_INACTIVE_DAYS: '0',
  POST_TYPE_TEXT: 'false',
  POST_TYPE_IMAGE: '0',
  POST_TYPE_VIDEO: 'no',
  POST_TYPE_AUDIO: 'off',
  VIDEO_PROCESSING: 'False',
  VIDEO_HEIGHTS: '480, 720 480',
  VIDEO_COMMENT_HEIGHT: '480',
  VIDEO_TIMEOUT_SECONDS: '120',
  VIDEO_FFMPEG_PATH: '/opt/ffmpeg/bin/ffmpeg',
  VIDEO_FFPROBE_PATH: '/opt/ffmpeg/bin/ffprobe',
  REPOSTS: 'false',
  REPOSTS_REMOTE: 'false',
  REPOSTS_SIGNING_KEYS: `${HEX_KEY}, ${BASE64_KEY}`,
  REPOSTS_REFRESH_HOURS: '0',
  REPOSTS_GONE_DAYS: '3',
  FEED_TAG_DAY_MAX_POSTS: '500',
  FEED_TAG_DAY_MIN_POSTS: '50',
  FEED_TAG_RETENTION_DAYS: '60',
  FEED_AUTHOR_DAY_MAX_POSTS: '2000',
  FEED_MAX_LOOKBACK_DAYS: '120',
  FEED_PREVIEW_WORDS: '50',
  FEED_PREVIEW_CHARS: '500',
  FEED_RELATED_TAGS: '0',
  FEED_HEAD_CACHE_MS: '250',
  FEED_RELATED_MIN_POSTS: '3',
  FEED_RELATED_MIN_PERCENT: '10',
  SUMMARY_HOT_DAYS: '4',
  SUMMARY_BROTLI_QUALITY: '5',
  COMPACT_INTERVAL_SECONDS: '10',
  COMPACT_GRACE_SECONDS: '0',
  COMPACT_CONCURRENCY: '2',
  COMPACT_COMMENT_WRITES: '8',
  COMPACT_LEASE_SECONDS: '90',
  TRUST_SCORE_DELETE_BELOW: '10',
  TRUST_SCORE_ALLOW_FROM: '60',
  TRUST_OPTIONAL_PLUGINS: 'urlhaus, pdq urlhaus',
  URLHAUS_AUTH_KEY: ' urlhaus-secret ',
  URLHAUS_LIST_URL: 'https://lists.example/{key}/recent.csv',
  URLHAUS_REFRESH_MINUTES: '30',
  PDQ_HASH_LIST: 'https://lists.example/pdq-secret.txt',
  PDQ_HASH_LIST_AUTHORIZATION: 'Bearer pdq-secret',
  PDQ_MAX_DISTANCE: '20',
  PDQ_MIN_QUALITY: '60',
  PDQ_REFRESH_MINUTES: '10',
  QUARANTINE_SCHEME: 's3',
  QUARANTINE_OPTIONS: '{"bucket":"quarantine","secret_access_key":"quarantine-secret"}',
  QUARANTINE_RETENTION_DAYS: '100',
  AUDIT_SCHEME: 's3',
  AUDIT_OPTIONS: '{"bucket":"audit"}',
  COMMENTS_HOT_HOURS: '12',
  INBOX_RETENTION_DAYS: '30',
  SEARCH_MAX_KEYWORDS: '50',
  MONETIZATION_FEED_ADS: 'true',
  MONETIZATION_POST_ADS: '1',
};

/** The secrets among them: what the binary prints only when it is asked to. */
const SECRETS = ['db-secret', 'redis-secret', 'content-secret', 'summary-secret', 'urlhaus-secret', 'pdq-secret', 'quarantine-secret', HEX_KEY, BASE64_KEY];

/** A configuration file, with settings in the types of JSON, and the forms a file can give them in. */
const FILE: Json = {
  db: { dialect: 'mysql', url: 'mysql://evie@db/evie', poolSize: '0x10', migrateOnStart: false },
  redis: { url: 'redis://from-the-file:6379', keyPrefix: '' },
  storage: {
    content: { scheme: 'azblob', options: { container: 'content', port: 9000, tls: true, nothing: null, list: [1, null, 'a'] }, signedUrlSeconds: 60 },
    tmpPath: '',
  },
  postTypes: { link: false },
  video: { heights: [240, '1080', 240], commentHeight: '144' },
  reposts: { signingKeys: [` ${HEX_KEY} `, ''], refreshHours: 1e2 },
  feed: { relatedMinPercent: 100, summaryBrotliQuality: 0 },
  compact: { intervalSeconds: 1, graceSeconds: 5 },
  trust: { deleteBelow: 0, allowFrom: 101, optionalPlugins: [' urlhaus ', 'urlhaus', ''] },
  urlhaus: { authKey: 'k', listUrl: ' HTTPS://lists.example/recent.csv ' },
  quarantine: { scheme: 'fs', options: '{"root":"/quarantine/"}' },
  monetization: { feedAds: true },
};

/** What the environment says beside the file: one of the file's settings again, which the environment decides, and one set to nothing, which is no setting. */
const BESIDE_FILE: Env = { COMPACT_INTERVAL_SECONDS: '3', COMPACT_GRACE_SECONDS: '', REDIS_KEY_PREFIX: '' };

/** The settings the binary leaves out where they aren't set, which the API then has none of either. */
const OPTIONAL = ['db.idleTimeoutMs', 'storage.summaries.scheme', 'storage.summaries.options', 'storage.tmpPath', 'urlhaus.authKey', 'pdq.hashList', 'pdq.authorization', 'quarantine.scheme', 'quarantine.options'];

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const at = (config: Json, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (isObject(node) ? node[key] : undefined), config);

/** Every setting of a resolved configuration by its path: a store's options are one setting, as a list is. */
function settings(config: Json, under = ''): Map<string, unknown> {
  const found = new Map<string, unknown>();
  for (const [key, value] of Object.entries(config)) {
    const path = under ? `${under}.${key}` : key;
    if (isObject(value) && key !== 'options') for (const [p, v] of settings(value, path)) found.set(p, v);
    else found.set(path, value);
  }
  return found;
}

/** What the binary resolved of an environment, read from what it prints. */
function binary(env: Env, file = NO_FILE): Json {
  const ran = runCompactor(['config', '--secrets'], { ...env, EVIEVERSE_CONFIG: file }, dir);
  expect(ran.stderr).toBe('');
  expect(ran.code).toBe(0);
  return JSON.parse(ran.stdout) as Json;
}

/** What the API resolved of the same, as JSON holds it: what is undefined is left out. */
const api = (env: Env, file = NO_FILE): Json => JSON.parse(JSON.stringify(loadConfig({}, { ...env, EVIEVERSE_CONFIG: file }))) as Json;

/** Holds every setting the binary resolved to the API's, and the ones it left out to the API having none. */
function same(env: Env, file = NO_FILE): Map<string, unknown> {
  const [ours, theirs] = [binary(env, file), api(env, file)];
  const resolved = settings(ours);
  expect(resolved.size).toBeGreaterThan(55);
  for (const [path, value] of resolved) expect({ [path]: value }).toEqual({ [path]: at(theirs, path) });
  for (const path of OPTIONAL) if (!resolved.has(path)) expect({ [path]: at(theirs, path) }).toEqual({ [path]: undefined });
  return resolved;
}

describe('the configuration the compactor resolves', () => {
  it('is the API\'s, of a server that sets only what it must', () => {
    const resolved = same(DEFAULTS);
    expect(resolved.get('db.dialect')).toBe('sqlite');
    expect(resolved.get('compact.intervalSeconds')).toBe(5);
    for (const path of OPTIONAL) expect(resolved.has(path), path).toBe(false);
  });

  it('is the API\'s, of every variable it reads and of a file', () => {
    const file = join(dir, 'evieverse.config.json');
    writeFileSync(file, JSON.stringify(FILE));
    const defaults = same(DEFAULTS);
    const everything = same(EVERYTHING);
    const fromFile = same(BESIDE_FILE, file);

    expect(everything.get('redis.url')).toBe('rediss://:redis-secret@redis.example:6380/2');
    expect(everything.get('video.heights')).toEqual([720, 480]);
    expect(everything.get('trust.optionalPlugins')).toEqual(['urlhaus', 'pdq']);
    // The environment over the file, and a variable set to nothing as one that isn't set.
    expect(fromFile.get('compact.intervalSeconds')).toBe(3);
    expect(fromFile.get('compact.graceSeconds')).toBe(5);
    expect(fromFile.get('redis.keyPrefix')).toBe('');
    expect(fromFile.get('db.poolSize')).toBe(16);
    expect(fromFile.get('storage.content.options')).toEqual({ container: 'content', port: '9000', tls: 'true', nothing: 'null', list: '1,,a' });

    // Every setting the binary has was read from something that set it, in one of the two: none is held only at its default.
    const all = new Set([...defaults.keys(), ...everything.keys(), ...fromFile.keys()]);
    const neverSet = [...all].filter((path) => [everything, fromFile].every((set) => JSON.stringify(set.get(path)) === JSON.stringify(defaults.get(path))));
    expect(neverSet).toEqual([]);
  });

  it('leaves its secrets out of what it prints, unless it is asked for them', () => {
    const shown = runCompactor(['config'], { ...EVERYTHING, EVIEVERSE_CONFIG: NO_FILE }, dir);
    expect(shown.code).toBe(0);
    for (const secret of SECRETS) expect(shown.stdout.includes(secret), secret).toBe(false);
    expect((JSON.parse(shown.stdout) as { storage: { content: { options: Json } } }).storage.content.options.bucket).toBe('<set>');
    const asked = runCompactor(['config', '--secrets'], { ...EVERYTHING, EVIEVERSE_CONFIG: NO_FILE }, dir);
    for (const secret of SECRETS) expect(asked.stdout.includes(secret), secret).toBe(true);
  });

  /** Settings neither side runs with, each beside what a server must set. */
  const REFUSED: Record<string, Env> = {
    'no Redis': { REDIS_URL: '' },
    'a Redis URL of spaces': { REDIS_URL: '   ' },
    'a dialect that is none': { DB_DIALECT: 'oracle' },
    'a pool of no connections': { DB_POOL_SIZE: '0' },
    'a number that is none': { DB_POOL_SIZE: 'ten' },
    'a number with a fraction': { COMPACT_CONCURRENCY: '1.5' },
    'options that are not JSON': { CONTENT_OPTIONS: '{bucket' },
    'options that are a list': { CONTENT_OPTIONS: '["bucket"]' },
    'a scheme of nothing but a file': {},
    'no type of post': { POST_TYPE_TEXT: 'no', POST_TYPE_IMAGE: 'no', POST_TYPE_VIDEO: 'no', POST_TYPE_AUDIO: 'no', POST_TYPE_LINK: 'no' },
    'a height that is none': { VIDEO_HEIGHTS: '720, tall' },
    'a height too small': { VIDEO_HEIGHTS: '100' },
    'nine heights': { VIDEO_HEIGHTS: '144 240 360 480 720 1080 1440 2160 200' },
    'a comment height too tall': { VIDEO_COMMENT_HEIGHT: '4320' },
    'a signing key that is none': { REPOSTS_SIGNING_KEYS: `${HEX_KEY} not-a-key-secret` },
    'a lookback too short': { FEED_MAX_LOOKBACK_DAYS: '6' },
    'a share above all': { FEED_RELATED_MIN_PERCENT: '101' },
    'a quality Brotli has none of': { SUMMARY_BROTLI_QUALITY: '12' },
    'no interval': { COMPACT_INTERVAL_SECONDS: '0' },
    'a lease too short': { COMPACT_LEASE_SECONDS: '29' },
    'a tagging mode that is none': { TAGGING_MODE: 'admin' },
    'a score to delete below above the one to allow from': { TRUST_SCORE_DELETE_BELOW: '80', TRUST_SCORE_ALLOW_FROM: '70' },
    'a score above all': { TRUST_SCORE_ALLOW_FROM: '102' },
    'urlhaus with no key': { TRUST_OPTIONAL_PLUGINS: 'urlhaus' },
    'a list that is no address': { URLHAUS_LIST_URL: 'ftp://lists.example/recent.csv' },
    'urlhaus refreshed too often': { URLHAUS_REFRESH_MINUTES: '4' },
    'pdq with no list': { TRUST_OPTIONAL_PLUGINS: 'pdq' },
    'pdq where every post is published': { TRUST_OPTIONAL_PLUGINS: 'pdq', PDQ_HASH_LIST: '/lists/pdq.txt', TRUST_SCORE_ALLOW_FROM: '0', TRUST_SCORE_DELETE_BELOW: '0' },
    'a distance past the hash': { PDQ_MAX_DISTANCE: '64' },
    'a quarantine in the content store': { QUARANTINE_SCHEME: 'fs', QUARANTINE_OPTIONS: '{"root":"./data/content/"}' },
    'a quarantine in the store of summaries': { SUMMARY_SCHEME: 's3', SUMMARY_OPTIONS: '{"bucket":"b"}', QUARANTINE_SCHEME: 's3', QUARANTINE_OPTIONS: '{"bucket":"b"}' },
    'a quarantine in the audit log\'s store': { AUDIT_SCHEME: 's3', AUDIT_OPTIONS: '{"bucket":"b"}', QUARANTINE_SCHEME: 's3', QUARANTINE_OPTIONS: '{"bucket":"b"}' },
  };

  it.each(Object.entries(REFUSED))('refuses %s, as the API does', (name, set) => {
    let file = NO_FILE;
    if (name === 'a scheme of nothing but a file') {
      file = join(dir, 'refused.json');
      writeFileSync(file, JSON.stringify({ storage: { content: { scheme: '' } } }));
    }
    const env = { ...DEFAULTS, ...set, EVIEVERSE_CONFIG: file };
    expect(() => loadConfig({}, env)).toThrow();
    const ran = runCompactor(['config', '--secrets'], env, dir);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain('the configuration is not one the server runs with');
    // What is wrong is said without the setting's value where that is a secret.
    expect(ran.stderr).not.toContain('not-a-key-secret');
  });

  it('says all that is wrong at once', () => {
    const ran = runCompactor(['config'], { DB_POOL_SIZE: 'ten', COMPACT_LEASE_SECONDS: '1', EVIEVERSE_CONFIG: NO_FILE }, dir);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('REDIS_URL is not set');
    expect(ran.stderr).toContain('db.poolSize');
    expect(ran.stderr).toContain('compact.leaseSeconds');
  });
});
