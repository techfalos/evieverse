import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { migrateToLatest, splitStatements, sqlMigrations } from '../src/db/migrator.js';

describe('SQL migrations', () => {
  it('has the portable schema migrations, in order', () => {
    expect(Object.keys(sqlMigrations())).toEqual([
      '0001_initial',
      '0002_pending_appends',
      '0003_content_deletion',
      '0004_superseded_versions',
      '0005_reserved_version',
      '0006_compactor_lease',
      '0007_ai_generated',
      '0008_federated_content',
      '0009_last_post_at',
      '0010_post_streak',
      '0011_recent_posts',
    ]);
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
      expect(tables).toEqual(['api_keys', 'compactor_lease', 'content', 'likes', 'pending_appends', 'superseded_versions', 'tags', 'users']);
      const columns = async (table: string) =>
        (await db.introspection.getTables()).find((t) => t.name === table)!.columns.map((c) => c.name).sort();
      expect(await columns('users')).toEqual([
        'created_at',
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

  it('starts reserved_version at the current version of existing content, and counts it as not AI-generated', async () => {
    const db = await createDb({ dialect: 'sqlite', url: ':memory:', poolSize: 1 });
    try {
      await new Migrator({ db, provider: { getMigrations: async () => sqlMigrations() } }).migrateTo('0004_superseded_versions');
      await sql`INSERT INTO users (id, username, created_at, updated_at) VALUES ('u1', 'alice', 0, 0)`.execute(db);
      await sql`INSERT INTO content (id, user_id, version, mime_type, size, sha256, created_at, updated_at) VALUES ('c1', 'u1', 4, 'text/plain', 1, 'x', 0, 0)`.execute(db);
      await migrateToLatest(db);
      expect(await db.selectFrom('content').select(['version', 'reserved_version', 'ai_generated']).execute()).toEqual([
        { version: 4, reserved_version: 4, ai_generated: 0 },
      ]);
    } finally {
      await db.destroy();
    }
  });
});
