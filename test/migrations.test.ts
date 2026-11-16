import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { migrateToLatest, splitStatements, sqlMigrations } from '../src/db/migrator.js';

describe('SQL migrations', () => {
  it('has the portable schema migration', () => {
    expect(Object.keys(sqlMigrations())).toEqual(['0001_initial']);
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
        'moderation_queue',
        'monetization',
        'reports',
        'reposts',
        'server_rules',
        'tag_moderation',
        'tag_moderators',
        'tag_mutes',
        'tag_pairs',
        'tags',
        'user_blocks',
        'users',
      ]);
      const columns = async (table: string) =>
        (await db.introspection.getTables()).find((t) => t.name === table)!.columns.map((c) => c.name).sort();
      expect(await columns('users')).toEqual([
        'admin',
        'ban_reason',
        'banned_at',
        'banned_by',
        'created_at',
        'deleted_at',
        'id',
        'language',
        'messages',
        'moderator',
        'show_followers',
        'show_following',
        'updated_at',
        'username',
      ]);
      expect(await columns('inbox')).toEqual(['body', 'content_id', 'created_at', 'id', 'kind', 'read_at', 'sender_id', 'tag', 'user_id']);
      expect(await columns('user_blocks')).toEqual(['blocked_id', 'created_at', 'user_id']);
      expect(await columns('server_rules')).toEqual(['body', 'created_at', 'id', 'sort_order', 'updated_at']);
      expect(await columns('content')).toEqual(['ai_generated', 'created_at', 'delete_requested_at', 'id', 'like_count', 'origin_hash', 'user_id']);
      expect(await columns('reposts')).toEqual(['content_id', 'created_at', 'likes_before', 'tag', 'user_id']);
      expect(await columns('api_keys')).toEqual(['created_at', 'id', 'key_hash', 'revoked_at', 'user_id']);
      expect(await columns('feed_queue')).toEqual(['committed', 'content_id', 'created_at', 'tag', 'token']);
      expect(await columns('tags')).toEqual(['created_at', 'last_appended_at', 'name']);
      expect(await columns('tag_pairs')).toEqual(['posts', 'tag_a', 'tag_b', 'updated_at']);
      expect(await columns('moderation_queue')).toEqual(['content_id', 'created_at', 'trust_score']);
      expect(await columns('tag_moderation')).toEqual(['applied_at', 'content_id', 'decided_at', 'decision', 'moderator_id', 'tag']);
      expect(await columns('reports')).toEqual(['accepted_at', 'content_id', 'created_at', 'reason', 'user_id']);
      expect(await columns('comment_queue')).toEqual(['comment_id', 'content_id', 'created_at', 'trust_score']);
      expect(await columns('comment_reports')).toEqual(['accepted_at', 'comment_id', 'content_id', 'created_at', 'reason', 'user_id']);
      expect(await columns('monetization')).toEqual([
        'clicks',
        'created_at',
        'created_by',
        'ends_at',
        'id',
        'image_type',
        'kind',
        'starts_at',
        'tags',
        'text',
        'updated_at',
        'url',
      ]);

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
      // A repost's rows go with the content, and outlast whoever reposted.
      await sql`INSERT INTO reposts (content_id, tag, user_id, likes_before, created_at) VALUES ('c1', 'news', 'u3', 2, 5), ('c2', 'news', 'u3', 0, 5)`.execute(db);
      await expect(sql`INSERT INTO reposts (content_id, tag, user_id, created_at) VALUES ('c1', 'news', 'u1', 6)`.execute(db)).rejects.toThrow(/UNIQUE/);
      await sql`DELETE FROM content WHERE id = 'c2'`.execute(db);
      await sql`DELETE FROM users WHERE id = 'u3'`.execute(db);
      expect(await db.selectFrom('reposts').selectAll().execute()).toEqual([{ content_id: 'c1', tag: 'news', user_id: null, likes_before: 2, created_at: 5 }]);

      await sql`DELETE FROM users WHERE id = 'u1'`.execute(db);
      expect((await db.selectFrom('api_keys').select('id').execute()).length).toBe(0);
      expect((await db.selectFrom('reposts').select('tag').execute()).length).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
