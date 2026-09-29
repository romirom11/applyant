// The first-launch setup (phase 16): Connections → Import → Preferences → Interview. Each step
// is done, skipped or left for later by the candidate; the app shows the setup until all four
// are settled. Search starts when Preferences is done: on a fresh install nothing searches
// before that (there are no strategies and no planner run), and finishing it starts the planner
// once, which proposes the strategies.
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  facts,
  projects,
  SETUP_STEPS,
  type SetupState,
  type SetupStepKey,
  searchPlans,
  searchStrategies,
  setupSteps,
  sources,
  tasks,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import { READABLE_KINDS } from '../knowledge/sources/registry.ts';
import { startPlan } from '../search/planner.ts';

export class SetupError extends Error {}

export interface StepView {
  step: SetupStepKey;
  state: SetupState;
  updatedAt: Date | null;
}

export function listSetupSteps(conn: Conn): StepView[] {
  const rows = new Map(
    conn
      .select()
      .from(setupSteps)
      .all()
      .map((r) => [r.step, r]),
  );
  return SETUP_STEPS.map((step) => {
    const row = rows.get(step);
    return { step, state: row?.state ?? 'pending', updatedAt: row?.updatedAt ?? null };
  });
}

/** Every step is done, skipped or left for later. */
export function setupDone(conn: Conn): boolean {
  return listSetupSteps(conn).every((s) => s.state !== 'pending');
}

/** Preferences is done, or the candidate set search up by hand (a strategy of their own). */
export function searchStarted(conn: Conn): boolean {
  const prefs = conn
    .select({ state: setupSteps.state })
    .from(setupSteps)
    .where(eq(setupSteps.step, 'preferences'))
    .get();
  if (prefs?.state === 'done') return true;
  return (
    conn
      .select({ id: searchStrategies.id })
      .from(searchStrategies)
      .where(eq(searchStrategies.origin, 'candidate'))
      .get() !== undefined
  );
}

export function parseStep(step: string, state: string): { step: SetupStepKey; state: SetupState } {
  const s = step.trim().toLowerCase() as SetupStepKey;
  if (!SETUP_STEPS.includes(s)) {
    throw new SetupError(`unknown setup step "${step}" (${SETUP_STEPS.join(' · ')})`);
  }
  const st = (state.trim().toLowerCase() || 'done') as SetupState;
  if (!['pending', 'done', 'skipped', 'later'].includes(st)) {
    throw new SetupError(`unknown state "${state}" (done · skipped · later · pending)`);
  }
  if (s === 'preferences' && (st === 'skipped' || st === 'later')) {
    // Search starts from the preferences; skipping them would leave it never started.
    throw new SetupError('Preferences can only be done: search starts from them');
  }
  return { step: s, state: st };
}

/**
 * Records a step. Preferences done for the first time starts search: the planner runs once
 * unless strategies or a plan already exist. Returns the plan it started, if any.
 */
export function setSetupStep(tx: Tx, step: SetupStepKey, state: SetupState): number | null {
  const wasStarted = searchStarted(tx.db);
  tx.db
    .insert(setupSteps)
    .values({ step, state, updatedAt: tx.now })
    .onConflictDoUpdate({ target: setupSteps.step, set: { state, updatedAt: tx.now } })
    .run();
  if (step !== 'preferences' || state !== 'done' || wasStarted) return null;
  const strategies = tx.db.select({ n: count() }).from(searchStrategies).get()?.n ?? 0;
  const plans = tx.db.select({ n: count() }).from(searchPlans).get()?.n ?? 0;
  if (strategies > 0 || plans > 0) return null;
  return startPlan(tx, 'setup');
}

export interface ImportView {
  sources: number;
  syncing: number;
  failed: number;
  projects: number;
  facts: number;
}

export function importProgress(conn: Conn): ImportView {
  const src = conn
    .select({ id: sources.id, note: sources.syncNote })
    .from(sources)
    .where(inArray(sources.kind, [...READABLE_KINDS]))
    .all();
  const syncing =
    conn
      .select({ n: count() })
      .from(tasks)
      .where(and(eq(tasks.kind, 'sync_source'), inArray(tasks.status, ['queued', 'running'])))
      .get()?.n ?? 0;
  return {
    sources: src.length,
    syncing,
    failed: src.filter((s) => s.note?.startsWith('sync failed')).length,
    projects: conn.select({ n: count() }).from(projects).get()?.n ?? 0,
    facts:
      conn.select({ n: count() }).from(facts).where(sql`${facts.status} != 'rejected'`).get()?.n ??
      0,
  };
}
