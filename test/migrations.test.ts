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
        'compactor_lease',
        'content',
        'follows',
        'likes',
        'pending_appends',
        'removed_tags',
        'superseded_versions',
        'tag_moderators',
        'tag_mutes',
        'tags',
        'users',
      ]);
      const columns = async (table: string) =>
        (await db.introspection.getTables()).find((t) => t.name === table)!.columns.map((c) => c.name).sort();
      expect(await columns('users')).toEqual([
        'admin',
        'created_at',
        'following_changed_at',
        'id',
        'last_post_at',
        'post_streak',
        'publisher_url',
        'recent_posts',
        'updated_at',
        'username',
      ]);
      expect(await columns('content')).toEqual([
        'ai_generated',
        'created_at',
        'delete_requested_at',
        'filename',
        'id',
        'like_count',
        'mime_type',
        'origin_content_id',
        'origin_server',
        'origin_version',
        'reserved_version',
        'sha256',
        'size',
        'updated_at',
        'user_id',
        'version',
      ]);
      expect(await columns('tags')).toEqual(['compacted_at', 'created_at', 'last_appended_at', 'name']);

      await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u1', 'alice', 0, 0)`.execute(db);
      await expect(sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u2', 'alice', 0, 0)`.execute(db)).rejects.toThrow(/UNIQUE/);
      await sql`INSERT INTO api_keys (id, user_id, key_prefix, key_hash, created_at) VALUES ('k1', 'u1', 'p', 'h', 0)`.execute(db);
      await expect(
        sql`INSERT INTO api_keys (id, user_id, key_prefix, key_hash, created_at) VALUES ('k2', 'missing', 'p', 'h', 0)`.execute(db),
      ).rejects.toThrow(/FOREIGN KEY/);
      await sql`DELETE FROM users WHERE id = 'u1'`.execute(db);
      expect((await db.selectFrom('api_keys').select('id').execute()).length).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});
