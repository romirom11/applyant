// sync_source: read one knowledge source, have the `extractor` role turn it into facts with
// evidence, and store them as `unconfirmed`.
//
//   slow phase (no transaction):  read the source → hash → extractor run → authorship rule
//                                 → claim check (code sources: cited work = claimed work)
//   commit:                       projects · facts(unconfirmed) + evidence · source note
//
// Re-syncs replace what the previous sync of this source extracted but nobody confirmed.
// Confirmed, edited and rejected facts stay; a re-extracted fact with the same text only
// gains evidence, and a rejected one is not brought back.
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  evidence,
  type FactKind,
  facts,
  type ProjectRow,
  projects,
  type SourceRow,
  sources,
} from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { type SourceExtraction, sourceExtractionSchema } from '../../models/schemas/index.ts';
import type { Handler, Outcome, Task, Tx } from '../../queue/types.ts';
import { applyAuthorship } from './authorship.ts';
import { checkClaims } from './claim-check.ts';
import { addEvidence } from './evidence.ts';
import {
  EXTRACTOR_SYSTEM,
  extractorPrompt,
  MAX_FACTS_PER_SOURCE,
  PROMPT_VERSION,
} from './extract-prompt.ts';
import { factKey, MAX_FACT_LENGTH } from './facts.ts';
import { getIdentities, type Identities } from './profile.ts';
import { createProject, fillProject, slugify } from './projects.ts';
import { readFileSource } from './sources/file.ts';
import { readGithubSource } from './sources/github.ts';
import { type SourceMaterial, SourceReadError } from './sources/material.ts';
import { readUrlSource } from './sources/url.ts';

/** Failed reads and extractor runs are retried this many times before the source is marked failed. */
export const SYNC_ATTEMPTS = 3;

export interface ExtractedFact {
  text: string;
  kind: FactKind;
  /** Project name as the extractor gave it (profile-level sources). */
  project: string | null;
  evidence: Array<{ locator: string | null; excerpt: string | null }>;
  /** Code sources: the candidate's own commits/PRs the fact cites (keys into Authorship.refs). */
  candidateRefs: string[];
}

export const syncSource: Handler<'sync_source'> = async (task, ctx) => {
  const source = ctx.read.select().from(sources).where(eq(sources.id, task.entityId)).get();
  if (!source) return { kind: 'done', commit: () => {} };
  const project = source.projectId
    ? (ctx.read.select().from(projects).where(eq(projects.id, source.projectId)).get() ?? null)
    : null;
  const identities = getIdentities(ctx.read);

  ctx.progress({ message: `reading ${source.kind} ${source.locator}` });
  let material: SourceMaterial;
  try {
    material = await readSource(source, identities, ctx.deps, ctx.signal);
  } catch (err) {
    ctx.signal.throwIfAborted();
    const permanent = err instanceof SourceReadError && err.permanent;
    return failOrRetry(task, source, (err as Error).message, permanent, ctx.now());
  }

  const hash = createHash('sha256')
    .update(PROMPT_VERSION)
    .update('\0')
    .update(project?.name ?? '')
    .update('\0')
    .update(material.text)
    .digest('hex');
  if (hash === source.contentHash) {
    return {
      kind: 'done',
      commit: (tx) => {
        tx.db
          .update(sources)
          .set({
            lastSyncedAt: tx.now,
            syncNote: `unchanged since the last sync · ${material.label}`,
          })
          .where(eq(sources.id, source.id))
          .run();
        tx.emit({
          kind: 'source.synced',
          entityId: source.id,
          message: `source ${source.id} unchanged`,
        });
      },
    };
  }

  ctx.progress({ message: `extracting facts from ${material.label}` });
  const knownProjects = ctx.read
    .select({ name: projects.name })
    .from(projects)
    .all()
    .map((p) => p.name);
  const res = await ctx.deps.models.run('extractor', {
    schema: sourceExtractionSchema,
    system: EXTRACTOR_SYSTEM,
    prompt: extractorPrompt({
      kind: source.kind,
      material,
      project: project ? { name: project.name, summary: project.summary } : null,
      knownProjects,
    }),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: validateExtraction,
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') return failOrRetry(task, source, res.reason, false, ctx.now());

  const prepared = prepareFacts(res.output, material);
  const { downgraded } = prepared;
  let extracted = prepared.facts;

  // Code sources: the candidate's cited commits/PRs must show the claimed work.
  let unsupported = 0;
  if (material.authorship) {
    const refs = material.authorship.refs;
    const toCheck = extracted.filter((f) => f.candidateRefs.length > 0);
    if (toCheck.length) {
      ctx.progress({ message: `checking ${toCheck.length} claims against the cited commits` });
      const checked = await checkClaims(
        toCheck.map((f) => ({
          text: f.text,
          kind: f.kind,
          refs: f.candidateRefs.map((r) => refs.get(r)).filter((r) => r !== undefined),
        })),
        ctx.deps.models,
        { taskId: task.id, signal: ctx.signal, progress: (message) => ctx.progress({ message }) },
      );
      if (checked.kind === 'limit') {
        return { kind: 'pause_provider', provider: checked.provider, until: checked.until };
      }
      if (checked.kind === 'failed') {
        return failOrRetry(task, source, `claim check: ${checked.reason}`, false, ctx.now());
      }
      const rejected = new Set(toCheck.filter((_, i) => !checked.verdicts[i]?.supported));
      unsupported = rejected.size;
      extracted = extracted.filter((f) => !rejected.has(f));
    }
  }

  return {
    kind: 'done',
    commit: (tx) => {
      const summary = applyExtraction(tx, {
        source,
        project,
        extraction: res.output,
        facts: extracted,
      });
      const note = [
        `${summary.inserted} new facts, ${summary.kept} already known, ${summary.removed} dropped`,
        summary.projectsCreated ? `${summary.projectsCreated} projects created` : null,
        downgraded ? `${downgraded} attributed to other contributors` : null,
        unsupported ? `${unsupported} left out: the cited commits don't show them` : null,
        material.label,
      ]
        .filter(Boolean)
        .join(' · ');
      tx.db
        .update(sources)
        .set({ lastSyncedAt: tx.now, contentHash: hash, syncNote: note })
        .where(eq(sources.id, source.id))
        .run();
      tx.emit({
        kind: 'source.synced',
        entityId: source.id,
        message: `source ${source.id}: ${note}`,
      });
    },
  };
};

async function readSource(
  source: SourceRow,
  identities: Identities,
  deps: Deps,
  signal: AbortSignal,
): Promise<SourceMaterial> {
  switch (source.kind) {
    case 'file':
      return readFileSource(source.locator, deps.text);
    case 'url':
      return readUrlSource(source.locator, deps.reader, signal);
    case 'github':
      return readGithubSource(source.locator, {
        reposDir: deps.dirs.repos,
        identities,
        signal,
        log: deps.log.child({ part: 'github' }),
        ...(deps.github !== undefined ? { gh: deps.github } : {}),
      });
    default:
      throw new SourceReadError(`${source.kind} sources can't be read yet`, true);
  }
}

function failOrRetry(
  task: Task<'sync_source'>,
  source: SourceRow,
  reason: string,
  permanent: boolean,
  now: Date,
): Outcome {
  if (!permanent && task.attempts + 1 < SYNC_ATTEMPTS) {
    return { kind: 'retry', after: new Date(now.getTime() + 60_000 * 2 ** task.attempts), reason };
  }
  return {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(sources)
        .set({ syncNote: `sync failed: ${reason}`.slice(0, 1000) })
        .where(eq(sources.id, source.id))
        .run();
      tx.emit({
        kind: 'source.synced',
        entityId: source.id,
        message: `source ${source.id} failed: ${reason}`,
      });
    },
  };
}

/**
 * What the schema can't say. A fact naming a project missing from `projects` is fine (the
 * project is created from the fact), and a fact without a locator still gets source-level
 * evidence, so only empty text fails the run.
 */
export function validateExtraction(out: SourceExtraction): string | null {
  const empty = out.facts.findIndex((f) => !f.text.trim());
  return empty === -1 ? null : `fact ${empty} has no text`;
}

/** Cleans extractor output and applies the authorship rule for code sources. */
export function prepareFacts(
  out: SourceExtraction,
  material: SourceMaterial,
): { facts: ExtractedFact[]; downgraded: number } {
  let downgraded = 0;
  const result: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const f of out.facts.slice(0, MAX_FACTS_PER_SOURCE)) {
    const text = f.text.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_LENGTH);
    if (!text) continue;
    let fact: ExtractedFact = {
      text,
      kind: f.kind,
      project: f.project?.trim() || null,
      evidence: f.evidence.map((e) => ({
        locator: e.locator.trim() || null,
        excerpt: e.quote?.trim() || null,
      })),
      candidateRefs: [],
    };
    if (material.authorship) {
      const applied = applyAuthorship(fact, material.authorship);
      fact = { ...applied.fact, candidateRefs: applied.candidateRefs };
      if (applied.downgraded) downgraded++;
    }
    const key = `${fact.project?.toLowerCase() ?? ''}\u0000${factKey(fact.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return { facts: result, downgraded };
}

export interface ApplyInput {
  source: SourceRow;
  /** The source's own project; null for profile-level sources. */
  project: ProjectRow | null;
  extraction: SourceExtraction;
  facts: ExtractedFact[];
}

export interface ApplySummary {
  inserted: number;
  kept: number;
  removed: number;
  projectsCreated: number;
}

/** The commit half of a sync. Runs inside tx2; reads current state through `tx`. */
export function applyExtraction(tx: Tx, input: ApplyInput): ApplySummary {
  const db = tx.db;
  const now = tx.now;
  let projectsCreated = 0;

  // Projects: a project-level source fills its own project; a profile-level source maps
  // names to existing projects (by name or slug) and creates the rest.
  const byName = new Map<string, number>();
  const current = (id: number) => db.select().from(projects).where(eq(projects.id, id)).get();
  if (input.project) {
    const own = current(input.project.id);
    const described =
      input.extraction.projects.find(
        (p) => p.name.trim().toLowerCase() === input.project?.name.toLowerCase(),
      ) ?? input.extraction.projects[0];
    if (own && described) fillProject(db, own, described, now);
  } else {
    for (const p of input.extraction.projects) {
      const name = p.name.trim();
      if (!name) continue;
      const existing = findByNameOrSlug(db, name);
      if (existing) {
        fillProject(db, existing, p, now);
        byName.set(name.toLowerCase(), existing.id);
      } else {
        const created = createProject(
          db,
          { name, summary: p.summary, role: p.role, period: p.period, stack: p.stack },
          now,
        );
        projectsCreated++;
        byName.set(name.toLowerCase(), created.id);
      }
    }
  }
  const projectIdFor = (f: ExtractedFact): number | null => {
    if (input.project) return input.project.id;
    if (!f.project) return null;
    const known = byName.get(f.project.toLowerCase());
    if (known !== undefined) return known;
    const existing = findByNameOrSlug(db, f.project);
    if (existing) {
      byName.set(f.project.toLowerCase(), existing.id);
      return existing.id;
    }
    const created = createProject(db, { name: f.project }, now);
    projectsCreated++;
    byName.set(f.project.toLowerCase(), created.id);
    return created.id;
  };

  // Drop this source's previous evidence; facts left with no evidence that nobody
  // confirmed, edited or rejected were only this source's guess, and are replaced.
  const previous = db
    .select({ factId: evidence.factId })
    .from(evidence)
    .where(eq(evidence.sourceId, input.source.id))
    .all()
    .map((r) => r.factId);
  db.delete(evidence).where(eq(evidence.sourceId, input.source.id)).run();

  let inserted = 0;
  let kept = 0;
  for (const f of input.facts) {
    const projectId = projectIdFor(f);
    const key = factKey(f.text);
    const same = db
      .select({ id: facts.id, text: facts.text, status: facts.status })
      .from(facts)
      .where(projectId === null ? sql`${facts.projectId} is null` : eq(facts.projectId, projectId))
      .all()
      .find((row) => factKey(row.text) === key);
    if (same) {
      if (same.status === 'rejected') continue;
      addEvidence(db, same.id, input.source.id, f.evidence);
      kept++;
      continue;
    }
    const row = db
      .insert(facts)
      .values({
        projectId,
        text: f.text,
        kind: f.kind,
        status: 'unconfirmed',
        origin: 'extracted',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: facts.id })
      .get();
    addEvidence(db, row.id, input.source.id, f.evidence);
    inserted++;
  }

  // What this source said before and no longer says (and nobody confirmed) goes.
  let removed = 0;
  const previousIds = [...new Set(previous)];
  if (previousIds.length) {
    const orphans = db
      .select({ id: facts.id })
      .from(facts)
      .where(
        and(
          inArray(facts.id, previousIds),
          eq(facts.status, 'unconfirmed'),
          eq(facts.origin, 'extracted'),
          sql`${facts.editedAt} is null`,
          sql`not exists (select 1 from ${evidence} where ${evidence.factId} = ${facts.id})`,
        ),
      )
      .all()
      .map((r) => r.id);
    if (orphans.length) removed = db.delete(facts).where(inArray(facts.id, orphans)).run().changes;
  }
  return { inserted, kept, removed, projectsCreated };
}

function findByNameOrSlug(db: Conn, name: string): ProjectRow | null {
  const lower = name.trim().toLowerCase();
  return (
    db.select().from(projects).where(sql`lower(${projects.name}) = ${lower}`).get() ??
    db
      .select()
      .from(projects)
      .where(eq(projects.slug, slugify(name)))
      .get() ??
    null
  );
}
