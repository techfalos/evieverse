import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createDb, isUniqueViolation } from '../src/db/index.js';
import { migrateToLatest, splitStatements, sqlMigrations } from '../src/db/migrator.js';
import { resetDatabase, TARGETS } from './helpers.js';

describe('SQL migrations', () => {
  it('has the portable schema migrations, in order', () => {
    expect(Object.keys(sqlMigrations())).toEqual(['0001_initial', '0002_pending_writes', '0003_staged_removals', '0004_unnumbered_writes', '0005_origin_gone', '0006_export_indexes', '0007_media', '0008_mention_notices', '0009_search', '0010_unlikes', '0011_tag_moderation', '0012_profiles', '0013_repost_removals', '0014_tag_log', '0015_moderator_activity', '0016_quarantine']);
  });

  it('splits scripts into statements, ignoring comment lines', () => {
    expect(splitStatements('-- a; comment\nCREATE TABLE a (x int);\n\nSELECT 1;\n')).toEqual(['CREATE TABLE a (x int)', 'SELECT 1']);
  });

  it('creates every table with working foreign keys and unique usernames', async () => {
    const db = await createDb({ dialect: 'sqlite', url: ':memory:', poolSize: 1 });
    try {
      await migrateToLatest(db);
      await migrateToLatest(db);
      const tables = (await db.introspection.getTables()).map((t) => t.name).sort();
      expect(tables).toEqual([
        'api_keys',
        'blocked_words',
        'comment_queue',
        'comment_reports',
        'compactor_lease',
        'content',
        'feed_queue',
        'follows',
        'inbox',
        'likes',
        'media_jobs',
        'moderation_queue',
        'monetization',
        'pending_writes',
        'pinned_posts',
        'quarantine',
        'quarantine_access',
        'reports',
        'repost_removals',
        'reposts',
        'search_terms',
        'server_rules',
        'staged_removals',
        'tag_claims',
        'tag_moderation',
        'tag_moderation_log',
        'tag_moderators',
        'tag_mutes',
        'tag_pairs',
        'tag_rules',
        'tags',
        'user_blocks',
        'users',
      ]);
      const columns = async (table: string) =>
        (await db.introspection.getTables()).find((t) => t.name === table)!.columns.map((c) => c.name).sort();
      expect(await columns('users')).toEqual([
        'admin',
        'avatar_id',
        'avatar_type',
        'ban_reason',
        'banned_at',
        'banned_by',
        'bio',
        'created_at',
        'deleted_at',
        'id',
        'language',
        'links',
        'messages',
        'moderator',
        'show_followers',
        'show_following',
        'updated_at',
        'username',
        'username_folded',
      ]);
      expect(await columns('search_terms')).toEqual(['content_id', 'created_at', 'term']);
      expect(await columns('inbox')).toEqual(['body', 'comment_id', 'content_id', 'created_at', 'id', 'kind', 'read_at', 'sender_id', 'tag', 'user_id']);
      expect(await columns('user_blocks')).toEqual(['blocked_id', 'created_at', 'user_id']);
      expect(await columns('pinned_posts')).toEqual(['content_id', 'created_at', 'user_id']);
      expect(await columns('server_rules')).toEqual(['body', 'created_at', 'id', 'sort_order', 'updated_at']);
      expect(await columns('content')).toEqual(['ai_generated', 'created_at', 'delete_requested_at', 'id', 'like_count', 'origin_check_at', 'origin_gone_at', 'origin_hash', 'seq', 'unliked_at', 'user_id']);
      expect(await columns('pending_writes')).toEqual(['comment_id', 'content_id', 'created_at', 'kind', 'net', 'payload', 'seq', 'staged_key', 'write_key']);
      expect(await columns('staged_removals')).toEqual(['content_id', 'remove_at', 'staged_key']);
      expect(await columns('reposts')).toEqual(['content_id', 'created_at', 'likes_before', 'tag', 'user_id']);
      expect(await columns('repost_removals')).toEqual(['content_id', 'created_at', 'id', 'reposted_at', 'tag']);
      expect(await columns('api_keys')).toEqual(['created_at', 'id', 'key_hash', 'revoked_at', 'user_id']);
      expect(await columns('feed_queue')).toEqual(['content_id', 'created_at', 'tag', 'token']);
      expect(await columns('tags')).toEqual(['created_at', 'last_appended_at', 'name']);
      expect(await columns('tag_pairs')).toEqual(['posts', 'tag_a', 'tag_b', 'updated_at']);
      expect(await columns('moderation_queue')).toEqual(['content_id', 'created_at', 'trust_score']);
      expect(await columns('tag_moderation')).toEqual(['applied_at', 'content_id', 'decided_at', 'decision', 'moderator_id', 'tag']);
      expect(await columns('tag_moderation_log')).toEqual(['content_id', 'created_at', 'decision', 'id', 'moderator_id', 'moderator_role', 'reason', 'tag']);
      expect(await columns('tag_claims')).toEqual(['created_at', 'review_until', 'tag', 'user_id']);
      expect(await columns('tag_moderators')).toEqual(['acted_at', 'created_at', 'tag', 'user_id']);
      expect(await columns('tag_rules')).toEqual(['body', 'created_at', 'id', 'sort_order', 'tag', 'updated_at']);
      expect(await columns('reports')).toEqual(['accepted_at', 'content_id', 'created_at', 'reason', 'user_id']);
      expect(await columns('comment_queue')).toEqual(['comment_id', 'content_id', 'created_at', 'trust_score']);
      expect(await columns('comment_reports')).toEqual(['accepted_at', 'comment_id', 'content_id', 'created_at', 'reason', 'user_id']);
      expect(await columns('monetization')).toEqual([
        'clicks',
        'created_at',
        'created_by',
        'ends_at',
        'id',
        'image_alt',
        'image_type',
        'kind',
        'starts_at',
        'tags',
        'text',
        'updated_at',
        'url',
      ]);
      expect(await columns('media_jobs')).toEqual(['attempts', 'claimed_until', 'client_ip', 'client_user_agent', 'comment_id', 'content_id', 'created_at', 'id', 'seq', 'write_key']);
      expect(await columns('quarantine')).toEqual(['created_at', 'facts', 'id', 'last_matched_at', 'matches', 'mime_type', 'report_id', 'reported_at', 'reported_by', 'sha256', 'size', 'user_id']);
      expect(await columns('quarantine_access')).toEqual(['action', 'created_at', 'id', 'ip', 'quarantine_id', 'user_agent', 'user_id']);

      await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u1', 'alice', 0, 0)`.execute(db);
      await expect(sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u2', 'alice', 0, 0)`.execute(db)).rejects.toThrow(/UNIQUE/);
      await sql`INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES ('k1', 'u1', 'h', 0)`.execute(db);
      await expect(
        sql`INSERT INTO api_keys (id, user_id, key_hash, created_at) VALUES ('k2', 'missing', 'h', 0)`.execute(db),
      ).rejects.toThrow(/FOREIGN KEY/);
      // One entry per original of another server; posts written here have no origin, however many there are.
      await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u3', 'bob', 0, 0)`.execute(db);
      await sql`INSERT INTO content (id, user_id, created_at) VALUES ('c1', 'u1', 0), ('c2', 'u1', 0)`.execute(db);
      await sql`INSERT INTO content (id, user_id, created_at, origin_hash) VALUES ('c3', 'u1', 0, 'abc')`.execute(db);
      await expect(sql`INSERT INTO content (id, user_id, created_at, origin_hash) VALUES ('c4', 'u1', 0, 'abc')`.execute(db)).rejects.toThrow(/UNIQUE/);
      // A user pins several posts to their profile, each of them once, and a pin goes with its post.
      await sql`INSERT INTO pinned_posts (user_id, content_id, created_at) VALUES ('u1', 'c1', 1), ('u1', 'c2', 2), ('u3', 'c1', 3)`.execute(db);
      await expect(sql`INSERT INTO pinned_posts (user_id, content_id, created_at) VALUES ('u1', 'c1', 4)`.execute(db)).rejects.toThrow(/UNIQUE/);
      // A repost's rows go with the content, and outlast whoever reposted.
      await sql`INSERT INTO reposts (content_id, tag, user_id, likes_before, created_at) VALUES ('c1', 'news', 'u3', 2, 5), ('c2', 'news', 'u3', 0, 5)`.execute(db);
      await expect(sql`INSERT INTO reposts (content_id, tag, user_id, created_at) VALUES ('c1', 'news', 'u1', 6)`.execute(db)).rejects.toThrow(/UNIQUE/);
      // The places of a removed repost wait for the compactor, any number of them under one hashtag of the content, and go with the content.
      await sql`INSERT INTO repost_removals (id, content_id, tag, reposted_at, created_at) VALUES ('r1', 'c2', 'news', 5, 6), ('r2', 'c2', 'news', 7, 8)`.execute(db);
      await expect(sql`INSERT INTO repost_removals (id, content_id, tag, reposted_at, created_at) VALUES ('r3', 'missing', 'news', 5, 6)`.execute(db)).rejects.toThrow(/FOREIGN KEY/);
      // A post's writes are numbered from the post's own count, which starts at nothing, and go with the post.
      expect(await db.selectFrom('content').select(['id', 'seq']).orderBy('id').execute()).toEqual(['c1', 'c2', 'c3'].map((id) => ({ id, seq: 0 })));
      await sql`INSERT INTO pending_writes (content_id, seq, kind, payload, created_at) VALUES ('c1', 1, 'post', '{"meta":{"tags":["news"]}}', 5), ('c2', 1, 'post', '{}', 5)`.execute(db);
      await sql`INSERT INTO pending_writes (content_id, seq, kind, comment_id, staged_key, created_at) VALUES ('c1', 2, 'comment_remove', 'm1', NULL, 6)`.execute(db);
      await expect(sql`INSERT INTO pending_writes (content_id, seq, kind, created_at) VALUES ('c1', 2, 'post', 7)`.execute(db)).rejects.toThrow(/UNIQUE/);
      await expect(sql`INSERT INTO pending_writes (content_id, seq, kind, created_at) VALUES ('missing', 1, 'post', 7)`.execute(db)).rejects.toThrow(/FOREIGN KEY/);
      // The writes that take no number have 0 and a key each: any number of them under one post, and each key once.
      await sql`INSERT INTO pending_writes (content_id, seq, write_key, kind, comment_id, created_at) VALUES ('c2', 0, 'm2', 'comment_put', 'm2', 7), ('c2', 0, 'm2:u1', 'comment_like', 'm2', 7), ('c2', 0, 'm2:u3', 'comment_like', 'm2', 7)`.execute(db);
      await expect(sql`INSERT INTO pending_writes (content_id, seq, write_key, kind, comment_id, created_at) VALUES ('c2', 0, 'm2:u1', 'comment_like', 'm2', 8)`.execute(db)).rejects.toThrow(/UNIQUE/);
      // A staged file that is kept is named once, and outlasts its post: the run that deletes the post deletes it.
      await sql`INSERT INTO staged_removals (staged_key, content_id, remove_at) VALUES ('staged/w1', 'c2', 9)`.execute(db);
      await expect(sql`INSERT INTO staged_removals (staged_key, content_id, remove_at) VALUES ('staged/w1', 'c1', 9)`.execute(db)).rejects.toThrow(/UNIQUE/);
      await sql`DELETE FROM content WHERE id = 'c2'`.execute(db);
      expect(await db.selectFrom('staged_removals').selectAll().execute()).toEqual([{ staged_key: 'staged/w1', content_id: 'c2', remove_at: 9 }]);
      expect(await db.selectFrom('repost_removals').select('id').execute()).toEqual([]);
      await sql`DELETE FROM users WHERE id = 'u3'`.execute(db);
      expect(await db.selectFrom('reposts').selectAll().execute()).toEqual([{ content_id: 'c1', tag: 'news', user_id: null, likes_before: 2, created_at: 5 }]);
      expect(await db.selectFrom('pending_writes').select(['content_id', 'seq', 'kind', 'comment_id']).orderBy('seq').execute()).toEqual([
        { content_id: 'c1', seq: 1, kind: 'post', comment_id: null },
        { content_id: 'c1', seq: 2, kind: 'comment_remove', comment_id: 'm1' },
      ]);

      await sql`DELETE FROM users WHERE id = 'u1'`.execute(db);
      expect((await db.selectFrom('api_keys').select('id').execute()).length).toBe(0);
      expect((await db.selectFrom('reposts').select('tag').execute()).length).toBe(0);
      expect((await db.selectFrom('pending_writes').select('seq').execute()).length).toBe(0);
      expect((await db.selectFrom('pinned_posts').select('content_id').execute()).length).toBe(0);
    } finally {
      await db.destroy();
    }
  });

  // One of each database: the migration that remakes a table is written once, for all three.
  for (const target of TARGETS.filter((t, i) => TARGETS.findIndex((other) => other.dialect === t.dialect) === i)) {
    it(`keeps the writes that waited when their table is remade for the writes that take no number (${target.name})`, async () => {
      const db = await createDb({ dialect: target.dialect, url: target.url, poolSize: 1 });
      try {
        await resetDatabase(db, target.dialect);
        const { error } = await new Migrator({ db, provider: { getMigrations: async () => sqlMigrations() } }).migrateTo('0003_staged_removals');
        expect(error).toBeUndefined();
        await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u1', 'alice', 0, 0)`.execute(db);
        await sql`INSERT INTO content (id, user_id, created_at, seq) VALUES ('c1', 'u1', 0, 3), ('c2', 'u1', 0, 1)`.execute(db);
        await sql`INSERT INTO pending_writes (content_id, seq, kind, payload, staged_key, created_at) VALUES ('c1', 1, 'post', '{"meta":{"tags":["news"]}}', 'staged/w1', 5), ('c2', 1, 'post', '{}', NULL, 5)`.execute(db);
        await sql`INSERT INTO pending_writes (content_id, seq, kind, comment_id, payload, created_at) VALUES ('c1', 2, 'comment_put', 'm1', '{"held":false}', 6), ('c1', 3, 'comment_remove', 'm1', NULL, 7)`.execute(db);

        await migrateToLatest(db);
        const rows = async () =>
          (await db.selectFrom('pending_writes').select(['content_id', 'seq', 'write_key', 'kind', 'comment_id', 'payload', 'staged_key', 'created_at']).orderBy('content_id').orderBy('seq').orderBy('write_key').execute()).map(
            (r) => ({ ...r, seq: Number(r.seq), created_at: Number(r.created_at), payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload }),
          );
        const kept = [
          { content_id: 'c1', seq: 1, write_key: '', kind: 'post', comment_id: null, payload: { meta: { tags: ['news'] } }, staged_key: 'staged/w1', created_at: 5 },
          { content_id: 'c1', seq: 2, write_key: '', kind: 'comment_put', comment_id: 'm1', payload: { held: false }, staged_key: null, created_at: 6 },
          { content_id: 'c1', seq: 3, write_key: '', kind: 'comment_remove', comment_id: 'm1', payload: null, staged_key: null, created_at: 7 },
          { content_id: 'c2', seq: 1, write_key: '', kind: 'post', comment_id: null, payload: {}, staged_key: null, created_at: 5 },
        ];
        expect(await rows()).toEqual(kept);
        expect((await db.introspection.getTables()).map((t) => t.name)).not.toContain('pending_writes_keyed');

        // A number is still a post's once, and the writes that take none are told apart by their keys.
        const insert = (seq: number, key: string) =>
          db.insertInto('pending_writes').values({ content_id: 'c1', seq, write_key: key, kind: 'comment_like', comment_id: 'm1', payload: null, staged_key: null, created_at: 8 }).execute();
        expect(await insert(3, '').then(() => false, isUniqueViolation)).toBe(true);
        await insert(0, 'm1:u1');
        await insert(0, 'm1:u2');
        expect(await insert(0, 'm1:u1').then(() => false, isUniqueViolation)).toBe(true);
        expect((await rows()).map((r) => `${r.content_id} ${r.seq} ${r.write_key}`)).toEqual(['c1 0 m1:u1', 'c1 0 m1:u2', 'c1 1 ', 'c1 2 ', 'c1 3 ', 'c2 1 ']);
        // They go with their post, as before.
        await sql`DELETE FROM content WHERE id = 'c1'`.execute(db);
        expect((await rows()).map((r) => `${r.content_id} ${r.seq}`)).toEqual(['c2 1']);
      } finally {
        await db.destroy();
      }
    });

    it(`keeps the hashtags' moderators there were when the server starts to keep when each last did something, and says of them that it doesn't know (${target.name})`, async () => {
      const db = await createDb({ dialect: target.dialect, url: target.url, poolSize: 1 });
      try {
        await resetDatabase(db, target.dialect);
        const { error } = await new Migrator({ db, provider: { getMigrations: async () => sqlMigrations() } }).migrateTo('0013_repost_removals');
        expect(error).toBeUndefined();
        await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u1', 'alice', 0, 0), ('u2', 'bob', 0, 0)`.execute(db);
        await sql`INSERT INTO tag_moderators (tag, user_id, created_at) VALUES ('cars', 'u1', 5), ('cars', 'u2', 6), ('news', 'u1', 7)`.execute(db);

        await migrateToLatest(db);
        const rows = async () =>
          (await db.selectFrom('tag_moderators').selectAll().orderBy('created_at').execute()).map((r) => ({ ...r, created_at: Number(r.created_at), acted_at: r.acted_at === null ? null : Number(r.acted_at) }));
        // Null, and not the time they became one: the compactor counts them from its next run (src/moderation/activity.ts).
        expect(await rows()).toEqual([
          { tag: 'cars', user_id: 'u1', created_at: 5, acted_at: null },
          { tag: 'cars', user_id: 'u2', created_at: 6, acted_at: null },
          { tag: 'news', user_id: 'u1', created_at: 7, acted_at: null },
        ]);
        // A moderator made from then on has the time with them.
        await db.insertInto('tag_moderators').values({ tag: 'news', user_id: 'u2', created_at: 8, acted_at: 8 }).execute();
        expect((await rows()).at(-1)).toEqual({ tag: 'news', user_id: 'u2', created_at: 8, acted_at: 8 });
      } finally {
        await db.destroy();
      }
    });
  }
});
