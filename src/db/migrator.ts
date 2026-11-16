import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';

/** SQL migrations live next to this file as `<name>.sql` (shipped to dist/ by the build). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Splits a SQL script into statements. Migration files must not put ';' inside strings or comments. */
export function splitStatements(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Migration files are portable SQL shared by every supported dialect. */
export function sqlMigrations(dir = MIGRATIONS_DIR): Record<string, Migration> {
  const migrations: Record<string, Migration> = {};
  for (const file of readdirSync(dir).sort()) {
    const name = /^(\d{4}_[a-z0-9_]+)\.sql$/.exec(file)?.[1];
    if (!name) continue;
    const statements = splitStatements(readFileSync(join(dir, file), 'utf8'));
    migrations[name] = {
      async up(db: Kysely<any>) {
        for (const statement of statements) await sql.raw(statement).execute(db);
      },
    };
  }
  return migrations;
}

export async function migrateToLatest(db: Kysely<any>): Promise<void> {
  const provider: MigrationProvider = { getMigrations: async () => sqlMigrations() };
  const { error, results } = await new Migrator({ db, provider }).migrateToLatest();
  const failed = results?.find((r) => r.status === 'Error');
  if (error || failed) {
    throw new Error(`Migration failed${failed ? ` at ${failed.migrationName}` : ''}: ${String(error)}`);
  }
}
