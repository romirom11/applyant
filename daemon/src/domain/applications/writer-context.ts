// What the application writer sees. Answering "tell us about X" is a project-choice problem
// more than a fact-search one, so the writer always gets the index of ALL projects (a few
// hundred tokens), then the matcher's evidence from scoring (already computed), facts
// retrieved for each question, and prior answers with their facts. It may pull more through
// search_facts / get_project (≤ 3 calls, capped by the MCP endpoint); whatever those return
// joins the citable set. Every fact id in the output must be in that set.
import { POINTS_BACK } from '../../browser/form-read.ts';
import type { ReadDb } from '../../db/client.ts';
import type { ReadExec } from '../../db/read-pool.ts';
import type { PostingRow } from '../../db/schema.ts';
import type { Embedder } from '../../models/embeddings.ts';
import type { WriterOutput } from '../../models/schemas/application.ts';
import { factRefs } from '../knowledge/facts.ts';
import { interviewFactIds } from '../knowledge/interview.ts';
import { listProjects } from '../knowledge/projects.ts';
import { type FactRef, retrieveFacts } from '../knowledge/retrieve.ts';
import { type PriorAnswer, priorAnswers } from './reuse.ts';

export interface ProjectIndexEntry {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
  role: string | null;
  stack: string[];
  period: string | null;
  factCount: number;
}

export interface WriterQuestion {
  /** q1, q2, … in form order. */
  id: string;
  fieldRef: string;
  label: string;
  kind: 'text' | 'choice';
  options: string[] | null;
  required: boolean;
  /** "asked only if [q2] is answered "Yes"" for questions revealed by another question. */
  condition: string | null;
  /** The label points back at instructions in the posting ("the exact phrase we asked for"). */
  pointsBack: boolean;
  retrieved: FactRef[];
}

export interface MatchedRequirement {
  text: string;
  verdict: string;
  facts: FactRef[];
}

export interface WriterContext {
  job: {
    title: string | null;
    company: string | null;
    summary: string | null;
    url: string;
    /** The posting text (capped), for "Why us?" and instructions the questions point back to. */
    text: string | null;
  };
  /** The candidate's effective values for this application that answers may state. */
  profile: Record<string, string>;
  projects: ProjectIndexEntry[];
  matched: MatchedRequirement[];
  questions: WriterQuestion[];
  priorAnswers: PriorAnswer[];
  /** Every fact the writer may cite; grows with tool results during the run. */
  citable: Map<number, FactRef>;
}

export const POSTING_TEXT_LIMIT = 14_000;
export const FACTS_PER_QUESTION = 8;

export async function buildWriterContext(
  read: ReadDb,
  deps: { readPool: ReadExec; embedder: Embedder },
  input: {
    applicationId: number;
    posting: PostingRow;
    questions: Array<Omit<WriterQuestion, 'retrieved' | 'pointsBack'>>;
    profile: Record<string, string>;
    signal: AbortSignal;
    onEmbedError?(err: Error): void;
  },
): Promise<WriterContext> {
  const { posting } = input;
  const projects: ProjectIndexEntry[] = listProjects(read).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    summary: p.summary,
    role: p.role,
    stack: p.stack,
    period: p.period,
    factCount: p.facts,
  }));

  const matches = (posting.matches ?? []).filter(
    (m) => (m.verdict === 'strong' || m.verdict === 'partial') && m.factIds.length,
  );
  const matchedFacts = factRefs(
    read,
    matches.flatMap((m) => m.factIds),
  );
  const matched: MatchedRequirement[] = matches.map((m) => ({
    text: m.text,
    verdict: m.verdict,
    facts: m.factIds.map((id) => matchedFacts.get(id)).filter((f): f is FactRef => !!f),
  }));

  let vectors: Array<Float32Array | null> = input.questions.map(() => null);
  if (input.questions.length) {
    try {
      vectors = await deps.embedder.embed(
        input.questions.map((q) => q.label),
        'query',
        input.signal,
      );
    } catch (err) {
      input.signal.throwIfAborted();
      input.onEmbedError?.(err as Error);
    }
  }
  const questions: WriterQuestion[] = [];
  for (const [i, q] of input.questions.entries()) {
    const hits = await retrieveFacts(
      deps.readPool,
      { text: q.label, vector: vectors[i] ?? null },
      FACTS_PER_QUESTION,
    );
    // What the candidate told the interview for this very question comes first.
    const told = [
      ...factRefs(read, interviewFactIds(read, input.applicationId, q.fieldRef)).values(),
    ];
    const retrieved = [
      ...told,
      ...hits.map(({ score: _score, ...f }) => f).filter((f) => !told.some((t) => t.id === f.id)),
    ];
    questions.push({ ...q, pointsBack: POINTS_BACK.test(q.label), retrieved });
  }

  const prior = new Map<string, PriorAnswer>();
  for (const q of questions.filter((x) => x.kind === 'text')) {
    for (const p of priorAnswers(read, input.applicationId, q.label)) prior.set(p.id, p);
  }
  const priorFacts = factRefs(
    read,
    [...prior.values()].flatMap((p) => p.sentences.flatMap((s) => s.factIds)),
  );

  const citable = new Map<number, FactRef>();
  for (const m of matched) for (const f of m.facts) citable.set(f.id, f);
  for (const q of questions) for (const f of q.retrieved) citable.set(f.id, f);
  for (const f of priorFacts.values()) citable.set(f.id, f);

  return {
    job: {
      title: posting.title,
      company: posting.company,
      summary: posting.extraction?.summary ?? null,
      url: posting.canonicalUrl,
      text: posting.text ? posting.text.slice(0, POSTING_TEXT_LIMIT) : null,
    },
    profile: input.profile,
    projects,
    matched,
    questions,
    priorAnswers: [...prior.values()],
    citable,
  };
}

/** Every cited fact id is in the context (tool-fetched facts included). Null = fine. */
export function assertCitable(out: WriterOutput, ctx: WriterContext): string | null {
  for (const d of out.drafts) {
    for (const s of d.sentences) {
      for (const id of s.factIds) {
        if (!ctx.citable.has(id)) {
          return `question ${d.question} cites fact #${id}, which it was not given`;
        }
      }
    }
  }
  return null;
}
