// Platform guardrails for LinkedIn and Xing (TDD: "fully automated under the candidate's own
// session, with platform guardrails"). Every task that touches a guarded platform — a search
// page run (14b's readers), an Easy Apply / Xing apply, or a web-form delivery whose target is on
// the platform — goes through `Guardrails.run`:
//
// - one lane per platform: tasks run one after another, never two tabs at once;
// - daily caps (rolling 24 h) per action, set in Settings / `applyant platforms caps`;
// - human pacing: a randomised gap between tasks, randomised delays between page actions and
//   while typing (`GuardedSession.pace` / `type`);
// - no background activity while the candidate is active in Applyant's profile on that platform
//   (the sign-in window is open, or they're on a platform page in the profile's window);
// - any challenge (checkpoint, identity check, captcha on the platform) pauses the platform and
//   goes to the candidate. It is never sent to CapMonster: deliver.ts passes no solver here.
//
// The pause and the action tally are written at once, in their own short transactions, not in
// the task's commit: the next task in the lane must see them before the first task's commit.
import { and, eq, gte } from 'drizzle-orm';
import type { Locator, Page } from 'playwright';
import type { Db } from '../db/client.ts';
import {
  PLATFORM_KEYS,
  type PlatformAction,
  type PlatformKey,
  type PlatformRow,
  platformActions,
  platforms,
} from '../db/schema.ts';
import type { EventBus } from '../queue/events.ts';
import { runInTx } from '../queue/tx.ts';
import { detectCaptcha, findCaptcha } from './captcha.ts';

export type { PlatformAction, PlatformKey };

export interface PlatformInfo {
  name: string;
  /** Hosts (and their subdomains) that belong to the platform. */
  hosts: string[];
  /** Default daily caps: a few searches every few hours; applications only as approved. */
  defaults: { searches: number; applications: number };
}

export const PLATFORMS: Record<PlatformKey, PlatformInfo> = {
  linkedin: {
    name: 'LinkedIn',
    hosts: ['linkedin.com', 'lnkd.in'],
    defaults: { searches: 8, applications: 15 },
  },
  xing: { name: 'Xing', hosts: ['xing.com'], defaults: { searches: 8, applications: 15 } },
};

/** The guarded platform a URL belongs to, or null (every other site is unguarded). */
export function platformOf(url: string | null | undefined): PlatformKey | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const key of PLATFORM_KEYS) {
    if (PLATFORMS[key].hosts.some((h) => host === h || host.endsWith(`.${h}`))) return key;
  }
  return null;
}

export function platformName(p: PlatformKey): string {
  return PLATFORMS[p].name;
}

// Where a platform sends a session it doesn't trust: checkpoints, identity checks, sign-in walls.
const CHALLENGE_PATH =
  /\/(checkpoint|authwall|uas\/login|login|signin|sign-in|captcha|challenge|security-check|verify|identity)(\/|$|\?)/i;
const CHALLENGE_TEXT =
  /(let'?s do a quick security check|security verification|verify (your )?identity|verify it'?s you|unusual activity|are you a (human|robot)|confirm (that )?you'?re (a )?human|sicherheitsüberprüfung|bestätige,? dass du ein mensch bist)/i;

/**
 * A platform challenge on the page (LinkedIn/Xing checkpoint, identity check, a captcha, a
 * sign-in wall) or null. Captchas count as challenges on a guarded platform: they are the
 * candidate's to answer, never a solver's.
 */
export async function detectChallenge(page: Page, platform: PlatformKey): Promise<string | null> {
  const name = platformName(platform);
  let url: URL | null = null;
  try {
    url = new URL(page.url());
  } catch {
    url = null;
  }
  if (url && platformOf(url.href) === platform && CHALLENGE_PATH.test(url.pathname)) {
    return `${name} asked to verify the session (${url.pathname})`;
  }
  const frame = detectCaptcha(page);
  if (frame) return `a captcha (${frame}) on ${name}`;
  const widget = await findCaptcha(page).catch(() => null);
  if (widget) return `a captcha (${widget.type}) on ${name}`;
  const text = await page
    .locator('body')
    .innerText({ timeout: 2000 })
    .catch(() => '');
  const m = CHALLENGE_TEXT.exec(text);
  if (m) return `${name} showed a security check ("${m[0]}")`;
  return null;
}

export class PlatformPaused extends Error {
  readonly platform: PlatformKey;
  readonly reason: string;
  constructor(platform: PlatformKey, reason: string) {
    super(
      `${platformName(platform)} is paused after a challenge (${reason}): check it in Applyant's browser, then \`applyant platforms resume ${platform}\``,
    );
    this.platform = platform;
    this.reason = reason;
  }
}

export class PlatformCapReached extends Error {
  readonly platform: PlatformKey;
  readonly action: PlatformAction;
  readonly cap: number;
  /** When the oldest counted action leaves the 24-hour window. */
  readonly until: Date;
  constructor(platform: PlatformKey, action: PlatformAction, cap: number, until: Date) {
    super(
      `${platformName(platform)}: the daily cap of ${cap} ${action === 'apply' ? 'applications' : 'searches'} is reached; next one after ${until.toISOString()}`,
    );
    this.platform = platform;
    this.action = action;
    this.cap = cap;
    this.until = until;
  }
}

/** Thrown inside a guarded task when the platform challenged it: the platform pauses. */
export class PlatformChallenge extends Error {
  readonly platform: PlatformKey;
  readonly reason: string;
  constructor(platform: PlatformKey, reason: string) {
    super(
      `${reason}. ${platformName(platform)} is paused: answer it yourself in Applyant's browser, then \`applyant platforms resume ${platform}\``,
    );
    this.platform = platform;
    this.reason = reason;
  }
}

/** Is the candidate using Applyant's profile on this platform right now? */
export interface ProfileActivity {
  activeOn(platform: PlatformKey): Promise<boolean>;
}

export interface PacingOptions {
  /** Gap between two tasks on one platform (ms), picked at random in [min, max]. */
  taskGapMs: [number, number];
  /** Between page actions. */
  actionMs: [number, number];
  /** Per typed character. */
  keyMs: [number, number];
  /** While the candidate is active: how often to look again, and for how long at most. */
  activePollMs: number;
  activeMaxWaitMs: number;
}

export const DEFAULT_PACING: PacingOptions = {
  taskGapMs: [45_000, 150_000],
  actionMs: [900, 2800],
  keyMs: [60, 190],
  activePollMs: 30_000,
  activeMaxWaitMs: 20 * 60_000,
};

/** The candidate stayed active in the profile for longer than the wait: try later. */
export class PlatformBusy extends Error {
  readonly platform: PlatformKey;
  constructor(platform: PlatformKey) {
    super(
      `you are using ${platformName(platform)} in Applyant's browser; it waits until you're done`,
    );
    this.platform = platform;
  }
}

export interface GuardrailsOptions {
  db: Db;
  bus: EventBus;
  activity?: ProfileActivity;
  pacing?: Partial<PacingOptions>;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What a guarded task gets: paced actions and the challenge check. */
export interface GuardedSession {
  readonly platform: PlatformKey;
  /** A randomised pause between page actions. */
  pace(): Promise<void>;
  /** Types like a person: one key at a time, randomised delays. */
  type(target: Locator, text: string): Promise<void>;
  /** Throws PlatformChallenge when the page is a challenge (the platform then pauses). */
  checkChallenge(page: Page): Promise<void>;
}

export interface PlatformStatus {
  platform: PlatformKey;
  name: string;
  searchesPerDay: number;
  applicationsPerDay: number;
  searchesToday: number;
  applicationsToday: number;
  pausedAt: Date | null;
  pauseReason: string | null;
  signedInAt: Date | null;
}

const DAY = 24 * 60 * 60_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class Guardrails {
  private readonly o: GuardrailsOptions;
  readonly pacing: PacingOptions;
  private readonly lanes = new Map<PlatformKey, Promise<void>>();
  private readonly lastEnd = new Map<PlatformKey, number>();
  private readonly running = new Map<PlatformKey, number>();

  constructor(o: GuardrailsOptions) {
    this.o = o;
    this.pacing = { ...DEFAULT_PACING, ...o.pacing };
  }

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private between([min, max]: [number, number]): number {
    return Math.round(min + (max - min) * (this.o.random ?? Math.random)());
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return ms > 0 ? (this.o.sleep ?? defaultSleep)(ms, signal) : Promise.resolve();
  }

  private row(platform: PlatformKey): PlatformRow | undefined {
    return this.o.db.select().from(platforms).where(eq(platforms.platform, platform)).get();
  }

  private upsert(
    platform: PlatformKey,
    set: Partial<PlatformRow>,
    event: { stage: string; message: string },
  ): void {
    runInTx(this.o.db, this.o.bus, { now: this.now() }, (tx) => {
      tx.db
        .insert(platforms)
        .values({ platform, ...set, updatedAt: tx.now })
        .onConflictDoUpdate({ target: platforms.platform, set: { ...set, updatedAt: tx.now } })
        .run();
      tx.emit({ kind: 'platform', stage: event.stage, message: `${platform}: ${event.message}` });
    });
  }

  caps(platform: PlatformKey): { searches: number; applications: number } {
    const r = this.row(platform);
    const d = PLATFORMS[platform].defaults;
    return {
      searches: r?.searchesPerDay ?? d.searches,
      applications: r?.applicationsPerDay ?? d.applications,
    };
  }

  private counted(platform: PlatformKey, action: PlatformAction): Date[] {
    const since = new Date(this.now().getTime() - DAY);
    return this.o.db
      .select({ at: platformActions.at })
      .from(platformActions)
      .where(
        and(
          eq(platformActions.platform, platform),
          eq(platformActions.action, action),
          gte(platformActions.at, since),
        ),
      )
      .all()
      .map((r) => r.at)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  status(platform: PlatformKey): PlatformStatus {
    const r = this.row(platform);
    const caps = this.caps(platform);
    return {
      platform,
      name: platformName(platform),
      searchesPerDay: caps.searches,
      applicationsPerDay: caps.applications,
      searchesToday: this.counted(platform, 'search').length,
      applicationsToday: this.counted(platform, 'apply').length,
      pausedAt: r?.pausedAt ?? null,
      pauseReason: r?.pauseReason ?? null,
      signedInAt: r?.signedInAt ?? null,
    };
  }

  list(): PlatformStatus[] {
    return PLATFORM_KEYS.map((p) => this.status(p));
  }

  setCaps(platform: PlatformKey, caps: { searches?: number | null; applications?: number | null }) {
    const set: Partial<PlatformRow> = {};
    if (caps.searches !== undefined) set.searchesPerDay = caps.searches;
    if (caps.applications !== undefined) set.applicationsPerDay = caps.applications;
    const c = { ...this.caps(platform), ...caps };
    this.upsert(platform, set, {
      stage: 'caps',
      message: `${c.searches} searches and ${c.applications} applications a day`,
    });
    return this.status(platform);
  }

  pause(platform: PlatformKey, reason: string): void {
    this.upsert(
      platform,
      { pausedAt: this.now(), pauseReason: reason.slice(0, 500) },
      { stage: 'paused', message: reason },
    );
  }

  resume(platform: PlatformKey): PlatformStatus {
    this.upsert(
      platform,
      { pausedAt: null, pauseReason: null },
      { stage: 'resumed', message: 'resumed' },
    );
    return this.status(platform);
  }

  markSignedIn(platform: PlatformKey): void {
    this.upsert(
      platform,
      { signedInAt: this.now() },
      { stage: 'signed_in', message: "Applyant's browser is signed in" },
    );
  }

  /** Whether a guarded task is running on the platform now (tests, status). */
  busy(platform: PlatformKey): boolean {
    return (this.running.get(platform) ?? 0) > 0;
  }

  /**
   * Runs one guarded task: refuses when paused or over the daily cap, waits its turn in the
   * platform's lane, waits while the candidate is active there, keeps a randomised gap after
   * the previous task, counts the action, then runs `fn` with paced actions. A challenge
   * (PlatformChallenge thrown by `fn` or `checkChallenge`) pauses the platform and is rethrown.
   */
  async run<T>(
    platform: PlatformKey,
    action: PlatformAction,
    fn: (s: GuardedSession) => Promise<T>,
    o: { signal?: AbortSignal; progress?(message: string): void; taskId?: number } = {},
  ): Promise<T> {
    this.admit(platform, action);
    const previous = this.lanes.get(platform) ?? Promise.resolve();
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lanes.set(
      platform,
      previous.then(() => mine),
    );
    try {
      if (this.running.get(platform))
        o.progress?.(`waiting for the ${platformName(platform)} task before this one`);
      await previous;
      o.signal?.throwIfAborted();
      // The one before may have hit a challenge or used up the cap.
      this.admit(platform, action);
      await this.waitWhileActive(platform, o);
      const last = this.lastEnd.get(platform);
      if (last !== undefined) {
        const gap = this.between(this.pacing.taskGapMs) - (this.now().getTime() - last);
        if (gap > 0) {
          o.progress?.(
            `pacing ${platformName(platform)}: next action in ${Math.round(gap / 1000)} s`,
          );
          await this.sleep(gap, o.signal);
        }
      }
      runInTx(this.o.db, this.o.bus, { now: this.now() }, (tx) => {
        tx.db
          .insert(platformActions)
          .values({ platform, action, taskId: o.taskId ?? null, at: tx.now })
          .run();
      });
      this.running.set(platform, (this.running.get(platform) ?? 0) + 1);
      try {
        return await fn(this.session(platform, o.signal));
      } catch (err) {
        if (err instanceof PlatformChallenge) this.pause(platform, err.reason);
        throw err;
      } finally {
        this.running.set(platform, (this.running.get(platform) ?? 1) - 1);
        this.lastEnd.set(platform, this.now().getTime());
      }
    } finally {
      release();
    }
  }

  /** Throws when the platform is paused or the action's daily cap is used up. */
  admit(platform: PlatformKey, action: PlatformAction): void {
    const r = this.row(platform);
    if (r?.pausedAt) throw new PlatformPaused(platform, r.pauseReason ?? 'a challenge');
    const caps = this.caps(platform);
    const cap = action === 'apply' ? caps.applications : caps.searches;
    const done = this.counted(platform, action);
    if (done.length >= cap) {
      const oldest = done[done.length - cap] ?? done[0] ?? this.now();
      throw new PlatformCapReached(platform, action, cap, new Date(oldest.getTime() + DAY));
    }
  }

  private async waitWhileActive(
    platform: PlatformKey,
    o: { signal?: AbortSignal; progress?(message: string): void },
  ): Promise<void> {
    if (!this.o.activity) return;
    const start = this.now().getTime();
    while (await this.o.activity.activeOn(platform)) {
      if (this.now().getTime() - start >= this.pacing.activeMaxWaitMs) {
        throw new PlatformBusy(platform);
      }
      o.progress?.(`you are using ${platformName(platform)} in Applyant's browser; waiting`);
      await this.sleep(this.pacing.activePollMs, o.signal);
    }
  }

  private session(platform: PlatformKey, signal?: AbortSignal): GuardedSession {
    return {
      platform,
      pace: () => this.sleep(this.between(this.pacing.actionMs), signal),
      type: async (target, text) => {
        await target.click();
        for (const ch of text) {
          await target.pressSequentially(ch);
          await this.sleep(this.between(this.pacing.keyMs), signal);
        }
      },
      checkChallenge: async (page) => {
        const found = await detectChallenge(page, platform);
        if (found) throw new PlatformChallenge(platform, found);
      },
    };
  }
}
