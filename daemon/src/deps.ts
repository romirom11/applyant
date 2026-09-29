// What task handlers may use during their slow phase. Built once in main.ts.
import type { Guardrails } from './browser/guardrails.ts';
import type { ReaderPool } from './browser/reader-pool.ts';
import type { SubmitProfile } from './browser/submit-profile.ts';
import type { TaskPages } from './browser/task-pages.ts';
import type { Channel } from './channels/channel.ts';
import type { ReadExec } from './db/read-pool.ts';
import type { GithubApi } from './domain/knowledge/sources/github.ts';
import type { TextExtractor } from './domain/knowledge/text/extract.ts';
import type { FxSource } from './domain/scoring/fx.ts';
import type { Fetch } from './domain/search/readers/types.ts';
import type { CaptchaSolver } from './integrations/capmonster.ts';
import type { MailAccess } from './integrations/mail-service.ts';
import type { McpAccess } from './mcp/server.ts';
import type { AgentRunner } from './models/agent-runner.ts';
import type { Embedder } from './models/embeddings.ts';
import type { Secrets } from './secrets/secrets.ts';
import type { Logger } from './util/log.ts';

export interface Deps {
  reader: ReaderPool;
  /** The headed, persistent submission browser (phase 6): delivery and logged-in sessions. */
  submit: SubmitProfile;
  /** Which task a browser MCP call belongs to, so it operates on the right live page. */
  taskPages: TaskPages;
  /** channel key ("web_form") → its Channel implementation. */
  channels: Record<string, Channel>;
  secrets: Secrets;
  /** The connected mailbox (phase 13): replies, emailed security codes, email applications. */
  mail?: MailAccess | null;
  /**
   * The captcha solver (phase 14: CapMonster Cloud); `configured()` is false without a key, and
   * captchas then go to the candidate.
   */
  captcha?: (CaptchaSolver & { configured(): Promise<boolean> }) | null;
  /** LinkedIn/Xing guardrails (phase 14): one lane, daily caps, pacing, pause on challenge. */
  guardrails?: Guardrails | null;
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
    /** files/: hand-off snapshots, delivery receipts and tailored CVs (files/cv) live here. */
    files: string;
    /** The candidate's CV template, used instead of the bundled "Clean" when it exists. */
    cvTemplate?: string | null;
  };
  /** HTTP for search readers (job boards, ATS list APIs, feeds); global fetch when unset. */
  fetch?: Fetch;
  /** Overrides the `gh`-backed GitHub API client (tests only). */
  github?: GithubApi | null;
  log: Logger;
}
