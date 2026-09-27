import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, type Db, openDb, openReadDb, type ReadDb } from '../../src/db/client.ts';

export interface TempDb {
  dir: string;
  db: Db;
  read: ReadDb;
  cleanup(): void;
}

export function tempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'applyant-test-'));
  const path = join(dir, 'applyant.db');
  const db = openDb(path);
  const read = openReadDb(path);
  return {
    dir,
    db,
    read,
    cleanup() {
      closeDb(read);
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
