import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, type Dialect } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type DbDialect = Config['db']['dialect'];

async function createDialect(cfg: Config['db']): Promise<Dialect> {
  switch (cfg.dialect) {
    case 'postgres': {
      const pg = (await import('pg')).default;
      // BIGINT (int8) columns hold epoch-ms timestamps and counts; parse them as JS numbers.
      pg.types.setTypeParser(20, (v: string) => Number(v));
      return new PostgresDialect({ pool: new pg.Pool({ connectionString: cfg.url, max: cfg.poolSize }) });
    }
    case 'mysql': {
      const mysql = await import('mysql2');
      return new MysqlDialect({
        pool: mysql.createPool({ uri: cfg.url, connectionLimit: cfg.poolSize, supportBigNumbers: true, bigNumberStrings: false }),
      });
    }
    case 'sqlite': {
      const Sqlite = (await import('better-sqlite3')).default;
      if (cfg.url !== ':memory:') mkdirSync(dirname(cfg.url), { recursive: true });
      const sqlite = new Sqlite(cfg.url);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('foreign_keys = ON');
      sqlite.pragma('busy_timeout = 5000');
      return new SqliteDialect({ database: sqlite });
    }
  }
}

export async function createDb(cfg: Config['db']): Promise<Db> {
  return new Kysely<Database>({ dialect: await createDialect(cfg) });
}

/** True if the error is a unique / primary-key constraint violation on any supported dialect. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; errno?: number } | null;
  if (!e) return false;
  return (
    e.code === '23505' || // postgres
    e.code === 'ER_DUP_ENTRY' || // mysql
    e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    e.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}
