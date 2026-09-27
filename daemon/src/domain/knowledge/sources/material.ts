// What a source reader hands the extractor: text plus how to cite places in it.

/** What one of the candidate's commits or PRs shows, for checking claims that cite it. */
export interface RefDetail {
  /** "commit:1a2b3c4d5e6f" · "pr:#12" */
  ref: string;
  title: string;
  body: string;
  paths: string[];
}

export interface Authorship {
  /** Full SHAs of commits by the candidate's identities. */
  candidateShas: Set<string>;
  /** Full SHAs of everyone else's commits. */
  otherShas: Set<string>;
  /** PRs that contain at least one commit by the candidate (opening one isn't enough). */
  candidatePrs: Set<number>;
  /** PRs the candidate opened whose commits are all by others (team evidence only). */
  otherPrs: Set<number>;
  /** Detail of every candidate commit (by full SHA) and PR (by "pr:<n>"). */
  refs: Map<string, RefDetail>;
}

export interface SourceMaterial {
  /** "CV.pdf · 2 pages", "github.com/acme/api · 412 commits (57 yours)". */
  label: string;
  title: string | null;
  /** The text the extractor reads. Locator markers ([page 2], commit SHAs) are inside. */
  text: string;
  /** How facts from this material must cite their evidence. */
  locatorRules: string;
  /** GitHub only: who wrote what, for the deterministic authorship rule. */
  authorship: Authorship | null;
}

/**
 * `permanent` failures (missing file, unsupported format, bad locator) are recorded on the
 * source for the candidate to fix; the rest are retried.
 */
export class SourceReadError extends Error {
  readonly permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'SourceReadError';
    this.permanent = permanent;
  }
}

/** The extractor reads at most this much of one source. */
export const MAX_MATERIAL_CHARS = 150_000;

export function clip(text: string, max = MAX_MATERIAL_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… ${text.length - max} more characters not shown]`;
}

export function pagesToText(pages: string[]): string {
  if (pages.length <= 1) return pages[0] ?? '';
  return pages.map((p, i) => `[page ${i + 1}]\n${p}`).join('\n\n');
}
