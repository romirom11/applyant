// search_planner (Codex by default): proposes search strategies from the candidate's profile and
// runs web searches (including `site:` queries on the ATS hosts) to find company boards.
//
//   plan_search  slow:    one planner run with the provider's web search, seeded from SQLite:
//                         preferences, profile, projects and skills, the strategies with their
//                         results, and the sources already read
//                commit:  boards → the watch list (sources, origin agent) · new strategies,
//                         marked agent-generated, each starting its first run · the plan row
//
// The candidate starts the planner (`applyant search plan`, or Plan searches in the app); once
// it has run, it runs again by itself every PLAN_EVERY_MS so new queries and boards keep coming.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import {
  facts,
  type SearchPlanRow,
  searchPlans,
  searchStrategies,
  tasks,
} from '../../db/schema.ts';
import { type PlannerOutput, plannerSchema } from '../../models/schemas/search.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { listProjects } from '../knowledge/projects.ts';
import { getPreferences } from '../scoring/prefs.ts';
import { BOARDS } from './readers/boards.ts';
import {
  KIND_LABELS,
  listSources,
  parseSourceInput,
  SearchError,
  sourceKey,
  validateSelectors,
} from './sources.ts';
import {
  addStrategy,
  DEFAULT_EVERY_MINUTES,
  listStrategies,
  MAX_EVERY_MINUTES,
  MIN_EVERY_MINUTES,
} from './strategies.ts';
import { watchBoards } from './watchlist.ts';

/** Once the planner has run, it runs again this long after its last run. */
export const PLAN_EVERY_MS = 7 * 24 * 3_600_000;
/** New strategies one plan may add. */
export const MAX_STRATEGIES_PER_PLAN = 5;
/** A failed planner run is retried this many times. */
export const PLAN_ATTEMPTS = 2;

function planBusy(conn: Conn): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, 'plan_search'), inArray(tasks.status, ['queued', 'running'])))
    .get();
}

/** Starts a planner run; null when one is already waiting or running. */
export function startPlan(tx: Tx, trigger: SearchPlanRow['trigger']): number | null {
  if (planBusy(tx.db)) return null;
  const plan = tx.db
    .insert(searchPlans)
    .values({ trigger, status: 'queued', startedAt: tx.now })
    .returning({ id: searchPlans.id })
    .get();
  tx.enqueue('plan_search', plan.id, { runId: null });
  tx.emit({
    kind: 'search.plan',
    entityId: plan.id,
    runId: null,
    stage: 'queued',
    message:
      trigger === 'manual'
        ? 'planning searches'
        : trigger === 'setup'
          ? 'planning searches (setup finished)'
          : 'planning searches (weekly)',
  });
  return plan.id;
}

/** The scheduler's part: a new plan a week after the last one (once the candidate ran one). */
export function schedulePlanner(tx: Tx): number | null {
  const last = latestPlans(tx.db, 1)[0];
  if (!last || last.status === 'queued') return null;
  if (tx.now.getTime() - last.startedAt.getTime() < PLAN_EVERY_MS) return null;
  return startPlan(tx, 'schedule');
}

export function latestPlans(conn: Conn, limit = 5): SearchPlanRow[] {
  return conn.select().from(searchPlans).orderBy(desc(searchPlans.id)).limit(limit).all();
}

// ---- The planner's view of the candidate and of search -----------------------------------------

export interface PlannerContext {
  preferences: Record<string, unknown>;
  profile: Record<string, string>;
  projects: Array<{
    name: string;
    role: string | null;
    period: string | null;
    stack: string[];
    summary: string | null;
  }>;
  skills: string[];
  strategies: Array<{
    name: string;
    origin: string;
    state: string;
    queries: string[];
    locations: string[];
    sources: string[];
    results: string;
  }>;
  sources: Array<{ key: string; label: string; origin: string; results: string }>;
}

function results(s: {
  found: number;
  verified: number;
  interested: number;
  skipped: number;
}): string {
  return `${s.found} found · ${s.verified} verified · ${s.interested} interested · ${s.skipped} skipped`;
}

export function plannerContext(conn: Conn): PlannerContext {
  const prefs = getPreferences(conn);
  const profile = getStandardProfile(conn);
  const skills = conn
    .select({ text: facts.text })
    .from(facts)
    .where(and(eq(facts.kind, 'skill'), inArray(facts.status, ['confirmed', 'unconfirmed'])))
    .orderBy(sql`case ${facts.status} when 'confirmed' then 0 else 1 end`, desc(facts.id))
    .limit(60)
    .all()
    .map((f) => f.text);
  const { sources } = listSources(conn);
  return {
    preferences: {
      roles: prefs.roles,
      seniority: prefs.seniority,
      basedIn: prefs.basedIn,
      basedCity: prefs.basedCity,
      locations: prefs.locations,
      remote: prefs.remote,
      salary: prefs.salary,
      languages: prefs.languages,
      workingLanguages: prefs.workingLanguages,
      employment: prefs.employment,
      dealbreakers: prefs.dealbreakers,
    },
    profile: Object.fromEntries(
      (['location', 'work_authorization', 'current_title', 'relocation'] as const)
        .map((k) => [k, profile[k]] as const)
        .filter((e): e is readonly [(typeof e)[0], string] => !!e[1]),
    ),
    projects: listProjects(conn)
      .slice(0, 40)
      .map((p) => ({
        name: p.name,
        role: p.role,
        period: p.period,
        stack: p.stack,
        summary: p.summary,
      })),
    skills,
    strategies: listStrategies(conn).map((s) => ({
      name: s.name,
      origin: s.origin,
      state: s.state,
      queries: s.queries,
      locations: s.locations,
      sources: s.sources,
      results: results(s.stats) + (s.cadence.note ? ` · ${s.cadence.note}` : ''),
    })),
    sources: sources.slice(0, 200).map((s) => ({
      key: s.key,
      label: s.label,
      origin: s.origin,
      results: results(s.stats),
    })),
  };
}

export const PLANNER_SYSTEM = `You plan job searches for one candidate in Applyant, a personal job-search tool. Applyant reads job boards on a schedule; you decide what it looks for and find new boards worth watching. You don't search for jobs to apply to yourself.

Strategies are what Applyant runs every few hours:
- queries: short title phrases; a job matches when every word of one phrase is in its title ("ai engineer", "llm", "founding engineer", "backend python"); "-word" excludes ("-intern"). Several phrases in one strategy are alternatives. Empty = every job of its sources.
- locations: words the job's location must contain ("remote" matches remote jobs; "greece", "cyprus", "europe", "berlin"); empty = anywhere.
- sources: which sources it reads: "all", a kind (greenhouse, ashby, lever, workable = company boards on those ATSs; page = company career pages and feeds; board = the job boards; telegram = Telegram job channels), a source key from the list, or the URL of a board you return below.
- Propose at most ${MAX_STRATEGIES_PER_PLAN} new strategies, only ones that add something the existing strategies don't cover (another role family the candidate fits, another location, a narrower query for a weak strategy). None is fine.

Boards: use web search to find companies whose job boards are worth watching for this candidate: companies hiring for the candidate's roles, stack and locations. Search the ATS hosts with site: queries (site:jobs.ashbyhq.com "AI Engineer" remote Europe · site:job-boards.greenhouse.io … · site:jobs.lever.co … · site:apply.workable.com …) and look for companies' own careers pages. For each board return the URL of the company's job list (https://jobs.ashbyhq.com/acme, https://job-boards.greenhouse.io/acme, https://jobs.lever.co/acme, https://apply.workable.com/acme, or https://acme.com/careers), not a single posting, not a search page and not an aggregator (LinkedIn, Indeed, Glassdoor…). Skip boards already in the source list. At most 25, the best fits first, each with one sentence on why it fits and the search that found it.

Telegram channels: also suggest public Telegram job channels worth following for this candidate (active channels that post single vacancies for the candidate's roles, stack, languages and locations; not chats, not channels of courses or ads). Return each as a board with the URL https://t.me/s/<channel>, why it fits and the search that found it (e.g. site:t.me/s "remote" "python" vacancy). At most 5, and only channels whose recent posts you saw.

List every web search you ran in searches.`;

export function plannerPrompt(c: PlannerContext): string {
  const lines = [
    'The candidate',
    `Preferences: ${JSON.stringify(c.preferences)}`,
    `Profile: ${JSON.stringify(c.profile)}`,
    'Projects:',
    ...(c.projects.length
      ? c.projects.map(
          (p) =>
            `- ${p.name}${p.role ? ` · ${p.role}` : ''}${p.period ? ` · ${p.period}` : ''}${p.stack.length ? ` · ${p.stack.join(', ')}` : ''}${p.summary ? ` — ${p.summary}` : ''}`,
        )
      : ['(none yet)']),
    'Skills (from their facts):',
    c.skills.length ? c.skills.map((s) => `- ${s}`).join('\n') : '(none yet)',
    '',
    'Search now',
    'Strategies:',
    ...(c.strategies.length
      ? c.strategies.map(
          (s) =>
            `- "${s.name}" (${s.origin}, ${s.state}) queries ${JSON.stringify(s.queries)} · locations ${JSON.stringify(s.locations)} · sources ${JSON.stringify(s.sources)} · ${s.results}`,
        )
      : ['(none yet)']),
    `Source kinds: ${Object.entries(KIND_LABELS)
      .map(([k, l]) => `${k} (${l})`)
      .join(', ')}`,
    `Job boards read through their APIs: ${Object.entries(BOARDS)
      .map(([id, label]) => `board:${id} (${label})`)
      .join(', ')}`,
    'Sources (key · label · who added it · results):',
    ...(c.sources.length
      ? c.sources.map((s) => `- ${s.key} · ${s.label} · ${s.origin} · ${s.results}`)
      : ['(none yet)']),
  ];
  return lines.join('\n');
}

export function validatePlan(o: PlannerOutput): string | null {
  for (const s of o.strategies) {
    if (!s.name.trim()) return 'every strategy needs a name';
    if (s.sources.length === 0) return `strategy "${s.name}": give its sources ("all" is fine)`;
  }
  // Boards that aren't usable (not a URL, an aggregator) are skipped when the plan is applied,
  // with the reason in the plan's note: one bad board doesn't cost the whole plan.
  return null;
}

// ---- Applying a plan --------------------------------------------------------------------------

const same = (a: string[], b: string[]) => {
  const norm = (l: string[]) =>
    [...new Set(l.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort().join('|');
  return norm(a) === norm(b);
};

export interface PlanApplied {
  strategies: number[];
  boards: string[];
  skipped: string[];
}

/** Boards → the watch list, strategies → agent-generated strategies (each starts a run). */
export function applyPlan(tx: Tx, planId: number, o: PlannerOutput): PlanApplied {
  const watched = watchBoards(tx, o.boards);
  const skipped: string[] = watched.rejected.map((r) => `board ${r.url}: ${r.reason}`);
  // A board URL a strategy names → that board's source key.
  const keyOf = (selector: string): string | null => {
    const s = selector.trim();
    if (/^https?:\/\//i.test(s)) {
      try {
        const input = parseSourceInput([s]);
        const key = sourceKey(input.kind, input.locator);
        return validateSelectors(tx.db, [key])[0] ?? null;
      } catch {
        return null;
      }
    }
    try {
      return validateSelectors(tx.db, [s])[0] ?? null;
    } catch {
      return null;
    }
  };
  const existing = tx.db.select().from(searchStrategies).all();
  const added: number[] = [];
  for (const s of o.strategies) {
    if (added.length >= MAX_STRATEGIES_PER_PLAN) {
      skipped.push(`strategy "${s.name}": more than ${MAX_STRATEGIES_PER_PLAN} in one plan`);
      continue;
    }
    const name = s.name.trim();
    const twin = existing.find(
      (e) => e.name === name || (same(e.queries, s.queries) && same(e.locations, s.locations)),
    );
    if (twin) {
      skipped.push(`strategy "${name}": the same as "${twin.name}"`);
      continue;
    }
    const sources = [...new Set(s.sources.map(keyOf).filter((k): k is string => !!k))];
    const hours = s.everyHours ?? DEFAULT_EVERY_MINUTES / 60;
    const every = Math.min(Math.max(Math.round(hours * 60), MIN_EVERY_MINUTES), MAX_EVERY_MINUTES);
    try {
      const res = addStrategy(tx, {
        name,
        queries: s.queries,
        locations: s.locations,
        sources: sources.length ? sources : ['all'],
        everyMinutes: every,
        origin: 'agent',
        note: s.why.trim() || null,
      });
      added.push(res.strategy.id);
      existing.push(res.strategy);
    } catch (err) {
      if (!(err instanceof SearchError)) throw err;
      skipped.push(`strategy "${name}": ${err.message}`);
    }
  }
  const boards = watched.added.map((b) => b.key);
  const note = [
    `${added.length} new strateg${added.length === 1 ? 'y' : 'ies'}`,
    `${boards.length} new board${boards.length === 1 ? '' : 's'} watched`,
    ...(watched.known.length ? [`${watched.known.length} already watched`] : []),
    `${o.searches.length} web search${o.searches.length === 1 ? '' : 'es'}`,
    ...(skipped.length ? [`skipped: ${skipped.slice(0, 6).join('; ')}`] : []),
    ...(o.note ? [o.note.trim()] : []),
  ].join(' · ');
  tx.db
    .update(searchPlans)
    .set({
      status: 'done',
      finishedAt: tx.now,
      strategies: added,
      boards,
      searches: o.searches.slice(0, 100),
      note,
    })
    .where(eq(searchPlans.id, planId))
    .run();
  tx.emit({ kind: 'search.plan', entityId: planId, runId: null, stage: 'done', message: note });
  return { strategies: added, boards, skipped };
}

function failPlan(tx: Tx, planId: number, reason: string): void {
  tx.db
    .update(searchPlans)
    .set({ status: 'failed', finishedAt: tx.now, note: reason })
    .where(eq(searchPlans.id, planId))
    .run();
  tx.emit({ kind: 'search.plan', entityId: planId, runId: null, stage: 'failed', message: reason });
}

export const planSearch: Handler<'plan_search'> = async (task, ctx) => {
  const plan = ctx.read.select().from(searchPlans).where(eq(searchPlans.id, task.entityId)).get();
  if (plan?.status !== 'queued') return { kind: 'done', commit: () => {} };
  ctx.progress({ message: 'planning searches' });
  const res = await ctx.deps.models.run('search_planner', {
    schema: plannerSchema,
    system: PLANNER_SYSTEM,
    prompt: plannerPrompt(plannerContext(ctx.read)),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: validatePlan,
    webSearch: true,
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') {
    if (task.attempts + 1 < PLAN_ATTEMPTS) {
      return {
        kind: 'retry',
        after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
        reason: res.reason,
      };
    }
    const reason = `the planner failed: ${res.reason}`;
    return { kind: 'done', commit: (tx) => failPlan(tx, plan.id, reason) };
  }
  const output = res.output;
  return { kind: 'done', commit: (tx) => void applyPlan(tx, plan.id, output) };
};
