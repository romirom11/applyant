// Every model call names a role; this table decides which provider and model answer it.
// Code never names a provider. The defaults below are the TDD's; phase 11 persists the
// table in SQLite and lets the candidate edit it (`applyant config roles`).

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
  // On-device; never falls back to a cloud model unless the candidate routes it there.
  email_classify: { route: r('apple'), minConfidence: 0.7, timeoutMs: MIN },
};

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
