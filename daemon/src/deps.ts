// What task handlers may use during their slow phase. Built once in main.ts.
import type { ReaderPool } from './browser/reader-pool.ts';
import type { ReadExec } from './db/read-pool.ts';
import type { GithubApi } from './domain/knowledge/sources/github.ts';
import type { TextExtractor } from './domain/knowledge/text/extract.ts';
import type { FxSource } from './domain/scoring/fx.ts';
import type { McpAccess } from './mcp/server.ts';
import type { AgentRunner } from './models/agent-runner.ts';
import type { Embedder } from './models/embeddings.ts';
import type { Secrets } from './secrets/secrets.ts';
import type { Logger } from './util/log.ts';

export interface Deps {
  reader: ReaderPool;
  secrets: Secrets;
  /** Every model call goes through a role here; handlers never name a provider. */
  models: AgentRunner;
  /** Fact and query embeddings (in-process). */
  embedder: Embedder;
  /** Heavy read queries (hybrid retrieval) on the worker-thread pool. */
  readPool: ReadExec;
  /** Daily reference exchange rates for salary comparison. */
  fx: FxSource;
  /** Applyant's MCP endpoint: per-task tool grants (the writer's knowledge lookups). */
  mcp: McpAccess | null;
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
