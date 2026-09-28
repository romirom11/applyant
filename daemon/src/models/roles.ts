// Every model call names a role; this table decides which provider and model answer it.
// Code never names a provider. The defaults below are the TDD's. The candidate's changes
// (`applyant config roles set matcher codex`) are rows in `role_routes`, one per changed role,
// laid over the defaults; `reset` deletes them, so a role then follows the default again.
import { and, eq, inArray } from 'drizzle-orm';
import type { Conn } from '../db/client.ts';
import { roleRoutes, tasks } from '../db/schema.ts';

export type Provider = 'claude' | 'codex' | 'jev' | 'apple';

export const ROLES = [
  'field_classify',
  'option_match',
  'posting_liveness',
  'form_agent',
  'extractor',
  'search_planner',
  'reader_builder',
  'matcher',
  'researcher',
  'application_writer',
  'claim_verifier',
  // The agent interview (phase 9): answers → facts, and the next question.
  'interviewer',
  // Every few days, a sample of a listing recipe's output: "is this a job title with its link?"
  'listing_check',
  'email_classify',
] as const;
export type Role = (typeof ROLES)[number];

export interface Route {
  provider: Provider;
  /** Provider-specific model name or alias (`sonnet`, `haiku`); null = the provider's default. */
  model: string | null;
}

export interface RoleConfig {
  route: Route;
  /** Jev answers below this confidence are re-asked of the fallback model. */
  minConfidence: number | null;
  /** Hard ceiling for one run of this role. */
  timeoutMs: number;
}

const r = (provider: Provider, model: string | null = null): Route => ({ provider, model });
const MIN = 60_000;

export const DEFAULT_ROLES: Record<Role, RoleConfig> = {
  field_classify: { route: r('jev'), minConfidence: 0.8, timeoutMs: MIN },
  option_match: { route: r('jev'), minConfidence: 0.8, timeoutMs: MIN },
  posting_liveness: { route: r('jev'), minConfidence: 0.8, timeoutMs: MIN },
  form_agent: { route: r('claude', 'sonnet'), minConfidence: null, timeoutMs: 10 * MIN },
  extractor: { route: r('claude', 'sonnet'), minConfidence: null, timeoutMs: 15 * MIN },
  search_planner: { route: r('codex'), minConfidence: null, timeoutMs: 20 * MIN },
  reader_builder: { route: r('claude', 'sonnet'), minConfidence: null, timeoutMs: 10 * MIN },
  matcher: { route: r('claude', 'sonnet'), minConfidence: null, timeoutMs: 10 * MIN },
  researcher: { route: r('codex'), minConfidence: null, timeoutMs: 20 * MIN },
  application_writer: { route: r('claude', 'opus'), minConfidence: null, timeoutMs: 15 * MIN },
  claim_verifier: { route: r('claude', 'haiku'), minConfidence: null, timeoutMs: 5 * MIN },
  interviewer: { route: r('claude', 'sonnet'), minConfidence: null, timeoutMs: 5 * MIN },
  listing_check: { route: r('jev'), minConfidence: 0.8, timeoutMs: MIN },
  // On-device; never falls back to a cloud model unless the candidate routes it there.
  email_classify: { route: r('apple'), minConfidence: 0.7, timeoutMs: MIN },
};

/** What each role does, for `applyant config roles`. */
export const ROLE_INFO: Record<Role, string> = {
  field_classify: 'what each form field asks for (batched per form)',
  option_match: 'which option of a choice field means the prepared value',
  posting_liveness: 'whether a posting is still open',
  form_agent: 'operates form controls and wizard steps the deterministic pass cannot',
  extractor: 'facts from sources · requirements, salary and location from postings',
  search_planner: 'proposes search strategies and finds new boards with web search',
  reader_builder: 'writes a listing recipe for a career page without a feed',
  matcher: 'strong / partial / missing per requirement, with facts',
  researcher: 'company research (phase 12)',
  application_writer: 'answers and the tailored CV',
  claim_verifier: 'checks each written sentence against its facts',
  interviewer: 'the agent interview',
  listing_check: "spot-checks a listing recipe's output every few days",
  email_classify: 'reads replies to applications (phase 13; on-device)',
};

/** Roles that are Choice decisions (AgentRunner.decide): the only ones Jev can answer. */
export const DECISION_ROLES: readonly Role[] = [
  'field_classify',
  'option_match',
  'posting_liveness',
  'listing_check',
];

/** Used when a provider is off, unavailable, or (Jev) not confident. */
export const DEFAULT_FALLBACKS: Partial<Record<Provider, Route>> = {
  jev: r('claude', 'haiku'),
};

export class RoleRoutingError extends Error {}

export interface RoutingTable {
  roles: Record<Role, RoleConfig>;
  fallbacks: Partial<Record<Provider, Route>>;
}

export const DEFAULT_ROUTING: RoutingTable = { roles: DEFAULT_ROLES, fallbacks: DEFAULT_FALLBACKS };

/**
 * The route for a role given which providers are available. A missing provider falls back
 * once (jev → claude:haiku); apple has no fallback, by design.
 */
export function routeFor(
  role: Role,
  available: ReadonlySet<Provider>,
  table: RoutingTable = DEFAULT_ROUTING,
): Route {
  const primary = table.roles[role].route;
  if (available.has(primary.provider)) return primary;
  const fallback = table.fallbacks[primary.provider];
  if (fallback && available.has(fallback.provider)) return fallback;
  throw new RoleRoutingError(
    `no provider for role ${role}: ${primary.provider} is not available${
      fallback ? ` and neither is its fallback ${fallback.provider}` : ''
    }`,
  );
}

export function describeRoute(route: Route): string {
  return route.model ? `${route.provider}:${route.model}` : route.provider;
}

/** Which role a task kind's model work runs under, so the queue can tag tasks by provider. */
export const TASK_ROLE: Partial<Record<string, Role>> = {
  sync_source: 'extractor',
  // Extraction, then (on the second pass) the matcher; both route to claude by default.
  score_posting: 'extractor',
  // Deterministic checks, then posting_liveness (Jev, falling back to claude:haiku).
  verify_posting: 'posting_liveness',
  // The form's own work is the browser; field_classify and option_match are Jev's.
  read_form: 'field_classify',
  // The writer is the expensive part; standard fields (option_match) and claim_verifier also run.
  prepare_application: 'application_writer',
  // Deterministic filling handles most of the form; form_agent only escalates for what it can't.
  deliver_application: 'form_agent',
  // The agent interview: the first question about a project, and each answer → facts + next.
  interview_open: 'interviewer',
  interview_turn: 'interviewer',
  // Search (phase 11): a listing recipe for a page, and the planner's strategies and boards.
  build_recipe: 'reader_builder',
  plan_search: 'search_planner',
};

/**
 * The provider a new task of this kind will most likely call, or null for tasks without
 * model work. Leasing skips tasks whose provider is paused by a subscription limit.
 */
export function providerForTask(
  kind: string,
  table: RoutingTable = DEFAULT_ROUTING,
): Provider | null {
  const role = TASK_ROLE[kind];
  return role ? table.roles[role].route.provider : null;
}

// ---- The candidate's routing (role_routes) ---------------------------------------------------

export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'jev', 'apple'];

export function isRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

/** "codex" · "claude:sonnet" · "claude:claude-opus-5" → a route. */
export function parseRoute(text: string): Route {
  const t = text.trim();
  const at = t.indexOf(':');
  const provider = (at < 0 ? t : t.slice(0, at)).trim().toLowerCase();
  const model = at < 0 ? null : t.slice(at + 1).trim() || null;
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new RoleRoutingError(
      `unknown provider "${provider}" (${PROVIDERS.join(' | ')}, optionally with :model)`,
    );
  }
  return { provider: provider as Provider, model };
}

/** Refuses routes that can't work: Jev only answers decisions, apple only reads mail. */
export function checkRoute(role: Role, route: Route): void {
  if (route.provider === 'jev' && !DECISION_ROLES.includes(role)) {
    throw new RoleRoutingError(
      `jev only answers bounded decisions (${DECISION_ROLES.join(', ')}); ${role} needs claude or codex`,
    );
  }
  if (route.provider === 'jev' && route.model) {
    throw new RoleRoutingError('jev has one model; use plain "jev"');
  }
  if (route.provider === 'apple' && role !== 'email_classify') {
    throw new RoleRoutingError('the on-device model only reads email (email_classify)');
  }
}

/** The defaults with the candidate's overrides laid over them. */
export function loadRouting(conn: Conn): RoutingTable {
  const rows = conn.select().from(roleRoutes).all();
  if (rows.length === 0) return DEFAULT_ROUTING;
  const roles = { ...DEFAULT_ROLES };
  for (const row of rows) {
    if (!isRole(row.role) || !(PROVIDERS as readonly string[]).includes(row.provider)) continue;
    roles[row.role] = {
      ...DEFAULT_ROLES[row.role],
      route: { provider: row.provider as Provider, model: row.model },
    };
  }
  return { roles, fallbacks: DEFAULT_FALLBACKS };
}

export interface RoleView {
  role: Role;
  route: Route;
  default: Route;
  overridden: boolean;
  /** Where a jev decision goes when Jev is off or unsure. */
  fallback: Route | null;
  info: string;
}

export function listRoles(conn: Conn): RoleView[] {
  const table = loadRouting(conn);
  const overridden = new Set(
    conn
      .select({ role: roleRoutes.role })
      .from(roleRoutes)
      .all()
      .map((r) => r.role),
  );
  return ROLES.map((role) => {
    const route = table.roles[role].route;
    return {
      role,
      route,
      default: DEFAULT_ROLES[role].route,
      overridden: overridden.has(role),
      fallback: table.fallbacks[route.provider] ?? null,
      info: ROLE_INFO[role],
    };
  });
}

/** Task kinds whose model work runs under `role` (TASK_ROLE). */
function kindsOf(role: Role): string[] {
  return Object.entries(TASK_ROLE)
    .filter(([, r]) => r === role)
    .map(([kind]) => kind);
}

/** Routes a role to a provider (and model); a route equal to the default removes the override. */
export function setRoleRoute(conn: Conn, role: string, routeText: string, now: Date): RoleView {
  if (!isRole(role)) {
    throw new RoleRoutingError(`unknown role "${role}" (${ROLES.join(', ')})`);
  }
  const route = parseRoute(routeText);
  checkRoute(role, route);
  const def = DEFAULT_ROLES[role].route;
  if (def.provider === route.provider && def.model === route.model) {
    conn.delete(roleRoutes).where(eq(roleRoutes.role, role)).run();
  } else {
    conn
      .insert(roleRoutes)
      .values({ role, provider: route.provider, model: route.model, updatedAt: now })
      .onConflictDoUpdate({
        target: roleRoutes.role,
        set: { provider: route.provider, model: route.model, updatedAt: now },
      })
      .run();
  }
  retagQueuedTasks(conn, role);
  const view = listRoles(conn).find((v) => v.role === role);
  if (!view) throw new RoleRoutingError(`unknown role "${role}"`);
  return view;
}

/** Back to the defaults: one role, or every role. Returns the roles that changed. */
export function resetRoleRoutes(conn: Conn, role: string | null): Role[] {
  if (role !== null && !isRole(role)) {
    throw new RoleRoutingError(`unknown role "${role}" (${ROLES.join(', ')})`);
  }
  const rows = conn.select({ role: roleRoutes.role }).from(roleRoutes).all();
  const reset = rows
    .map((r) => r.role)
    .filter((r): r is Role => isRole(r) && (!role || r === role));
  if (reset.length === 0) return [];
  conn.delete(roleRoutes).where(inArray(roleRoutes.role, reset)).run();
  for (const r of reset) retagQueuedTasks(conn, r);
  return reset;
}

/**
 * Queued tasks of the role's kinds follow its new route, so a limit pause on the old provider
 * doesn't hold them (and a pause on the new one does).
 */
function retagQueuedTasks(conn: Conn, role: Role): void {
  const provider = loadRouting(conn).roles[role].route.provider;
  const kinds = kindsOf(role);
  if (kinds.length === 0) return;
  conn
    .update(tasks)
    .set({ provider })
    .where(and(inArray(tasks.kind, kinds), eq(tasks.status, 'queued')))
    .run();
}
