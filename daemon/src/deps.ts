// What task handlers may use during their slow phase. Built once in main.ts.
import type { ReaderPool } from './browser/reader-pool.ts';
import type { GithubApi } from './domain/knowledge/sources/github.ts';
import type { TextExtractor } from './domain/knowledge/text/extract.ts';
import type { AgentRunner } from './models/agent-runner.ts';
import type { Secrets } from './secrets/secrets.ts';
import type { Logger } from './util/log.ts';

export interface Deps {
  reader: ReaderPool;
  secrets: Secrets;
  /** Every model call goes through a role here; handlers never name a provider. */
  models: AgentRunner;
  /** Documents → text (pdfjs-dist here; applyant-native on the Mac from 8a). */
  text: TextExtractor;
  dirs: {
    /** Partial clones of GitHub sources. */
    repos: string;
  };
  /** Overrides the `gh`-backed GitHub API client (tests only). */
  github?: GithubApi | null;
  log: Logger;
}
