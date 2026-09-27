import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as sqliteVec from 'sqlite-vec';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };
/** The transaction handle Drizzle passes to `db.transaction(cb)`. Synchronous by type. */
export type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];
/**
 * A handle on a read-only connection. Task handlers get this during their slow phase,
 * so a write outside the queue's commit fails at the driver.
 */
export type ReadDb = Db;

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

function open(path: string, readonly: boolean): Database.Database {
  const conn = new Database(path, { readonly, fileMustExist: readonly });
  conn.pragma('busy_timeout = 5000');
  if (!readonly) {
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
  }
  conn.pragma('foreign_keys = ON');
  // Every connection loads sqlite-vec, so a vec0 MATCH works on any of them (phase 3).
  sqliteVec.load(conn);
  return conn;
}

/** Opens the single writer connection and brings the schema up to date. */
export function openDb(path: string): Db {
  const conn = open(path, false);
  const db = drizzle(conn, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

/** Opens a read-only connection on an existing database. */
export function openReadDb(path: string): ReadDb {
  return drizzle(open(path, true), { schema });
}

export function closeDb(db: Db): void {
  db.$client.close();
}
