import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect, type AnyColumn, type Dialect, type InsertQueryBuilder, type Transaction, type UpdateObject } from 'kysely';
import type { Config } from '../config.js';
import { migrateToLatest } from './migrator.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type DbDialect = Config['db']['dialect'];

/** How to connect; whether the schema is migrated first is openDb's business. */
type Connection = Omit<Config['db'], 'migrateOnStart'>;

async function createDialect(cfg: Connection): Promise<Dialect> {
  const idle = cfg.idleTimeoutMs;
  switch (cfg.dialect) {
    case 'postgres': {
      const pg = (await import('pg')).default;
      // BIGINT (int8) columns hold epoch-ms timestamps and counts; parse them as JS numbers.
      pg.types.setTypeParser(20, (v: string) => Number(v));
      const pool = new pg.Pool({ connectionString: cfg.url, max: cfg.poolSize, ...(idle !== undefined && { idleTimeoutMillis: idle }) });
      // An idle connection the server closed (while a function instance was frozen, say) is dropped by
      // the pool, which reports it here; with no listener that would end the process.
      pool.on('error', () => {});
      return new PostgresDialect({ pool });
    }
    case 'mysql': {
      return new MysqlDialect({
        pool: (await import('mysql2')).createPool({
          uri: cfg.url,
          connectionLimit: cfg.poolSize,
          supportBigNumbers: true,
          bigNumberStrings: false,
          // The pool only closes idle connections beyond maxIdle.
          ...(idle !== undefined && { maxIdle: 0, idleTimeout: idle }),
        }),
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

/**
 * The database `cfg` names, with its schema as it is: nothing is migrated (see `openDb`). A SQLite
 * file's directory is created if it isn't there. The caller closes it with `destroy()`.
 */
export async function createDb(cfg: Connection): Promise<Db> {
  return new Kysely<Database>({ dialect: await createDialect(cfg) });
}

/** The database, with its schema brought up to date first unless `migrateOnStart` is off. */
export async function openDb(cfg: Config['db']): Promise<Db> {
  const db = await createDb(cfg);
  if (!cfg.migrateOnStart) return db;
  try {
    await migrateToLatest(db);
  } catch (err) {
    await db.destroy();
    throw err;
  }
  return db;
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

/**
 * Locks a user's row until the transaction ends, so a user's transactions that start with it take
 * turns. SQLite has no row locks and needs none here: its one connection runs one transaction at a time.
 */
export async function lockUser(trx: Transaction<Database>, dialect: DbDialect, userId: string): Promise<void> {
  const row = trx.selectFrom('users').select('id').where('id', '=', userId);
  if (dialect === 'sqlite') return;
  // Postgres: the lock an UPDATE of the row takes, which inserts of rows that reference the user don't wait for.
  await (dialect === 'postgres' ? row.forNoKeyUpdate() : row.forUpdate()).execute();
}

/** Makes an insert leave the rows that are already there as they are. */
export function ignoreConflicts<TB extends keyof Database, O>(insert: InsertQueryBuilder<Database, TB, O>, dialect: DbDialect) {
  return dialect === 'mysql' ? insert.ignore() : insert.onConflict((oc) => oc.doNothing());
}

/** Makes an insert set `update` on the row whose `key` (a column, or the columns of a composite key) is already there. */
export function updateOnConflict<TB extends keyof Database, O>(
  insert: InsertQueryBuilder<Database, TB, O>,
  dialect: DbDialect,
  key: AnyColumn<Database, TB> | readonly AnyColumn<Database, TB>[],
  update: UpdateObject<Database, TB, TB>,
) {
  if (dialect === 'mysql') return insert.onDuplicateKeyUpdate(update);
  const columns = typeof key === 'string' ? [key] : key;
  // Kysely types the same update differently here, and TypeScript can't tell the two agree for every table.
  return insert.onConflict((oc) => oc.columns(columns as never).doUpdateSet(update as never));
}

/**
 * Inserts a row unless it's there, and returns when it was added. A concurrent request that inserted
 * it first counts as there.
 */
export async function addOnce(
  now: () => number,
  find: () => Promise<{ created_at: number } | undefined>,
  insert: (createdAt: number) => Promise<unknown>,
): Promise<{ at: number; already: boolean }> {
  const found = await find();
  if (found) return { at: found.created_at, already: true };
  const at = now();
  try {
    await insert(at);
    return { at, already: false };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { at: (await find())?.created_at ?? at, already: true };
  }
}
