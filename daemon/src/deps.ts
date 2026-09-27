// What task handlers may use during their slow phase. Built once in main.ts.
import type { ReaderPool } from './browser/reader-pool.ts';
import type { Secrets } from './secrets/secrets.ts';
import type { Logger } from './util/log.ts';

export interface Deps {
  reader: ReaderPool;
  secrets: Secrets;
  log: Logger;
}
