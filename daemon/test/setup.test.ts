// The first-launch setup (phase 16): the steps, the preferences draft from the CV's facts, and
// search starting only once Preferences is done.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { facts, searchPlans, searchRuns, tasks } from '../src/db/schema.ts';
import { setProfileValue } from '../src/domain/knowledge/profile.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import { setPreference } from '../src/domain/scoring/prefs.ts';
import { addStrategy } from '../src/domain/search/strategies.ts';
import { preferencesDraft } from '../src/domain/setup/prefs-draft.ts';
import {
  importProgress,
  listSetupSteps,
  parseStep,
  SetupError,
  searchStarted,
  setSetupStep,
  setupDone,
} from '../src/domain/setup/steps.ts';
import { EventBus } from '../src/queue/events.ts';
import { Scheduler } from '../src/queue/scheduler.ts';
import { runInTx } from '../src/queue/tx.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { quietLog } from './helpers/deps.ts';

describe('setup', () => {
  let t: TempDb;
  let bus: EventBus;
  const now = new Date('2026-09-29T10:00:00Z');
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) => runInTx(t.db, bus, { now }, fn);

  beforeEach(() => {
    t = tempDb();
    bus = new EventBus();
  });
  afterEach(() => t.cleanup());

  const addFact = (text: string, kind: 'role' | 'skill' | 'other' | 'personal_contribution') =>
    t.db
      .insert(facts)
      .values({
        projectId: null,
        text,
        kind,
        status: 'unconfirmed',
        origin: 'extracted',
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: facts.id })
      .get().id;

  it('starts with four pending steps and nothing searching, even as the scheduler ticks', () => {
    expect(listSetupSteps(t.db).map((s) => `${s.step}:${s.state}`)).toEqual([
      'connections:pending',
      'import:pending',
      'preferences:pending',
      'interview:pending',
    ]);
    expect(setupDone(t.db)).toBe(false);
    expect(searchStarted(t.db)).toBe(false);
    const scheduler = new Scheduler({
      db: t.db,
      bus,
      log: quietLog,
      intervalMs: 60_000,
      now: () => now,
    });
    expect(scheduler.tick('schedule')).toEqual([]);
    expect(scheduler.tick('wake')).toEqual([]);
    expect(t.db.select().from(searchRuns).all()).toHaveLength(0);
    expect(t.db.select().from(searchPlans).all()).toHaveLength(0);
    expect(t.db.select().from(tasks).all()).toHaveLength(0);
  });

  it('starts search when Preferences is done: the planner runs once', () => {
    tx((x) => setSetupStep(x, 'connections', 'done'));
    tx((x) => setSetupStep(x, 'import', 'skipped'));
    expect(searchStarted(t.db)).toBe(false);
    expect(t.db.select().from(searchPlans).all()).toHaveLength(0);

    const plan = tx((x) => setSetupStep(x, 'preferences', 'done'));
    expect(plan).toBeGreaterThan(0);
    expect(searchStarted(t.db)).toBe(true);
    expect(t.db.select().from(searchPlans).all()).toMatchObject([
      { trigger: 'setup', status: 'queued' },
    ]);
    expect(t.db.select().from(tasks).all()).toMatchObject([
      { kind: 'plan_search', entityId: plan },
    ]);
    // Done again (the candidate came back to the step): nothing new starts.
    expect(tx((x) => setSetupStep(x, 'preferences', 'done'))).toBeNull();
    expect(setupDone(t.db)).toBe(false);
    tx((x) => setSetupStep(x, 'interview', 'later'));
    expect(setupDone(t.db)).toBe(true);
  });

  it('leaves search the candidate set up by hand alone', () => {
    tx((x) => addStrategy(x, { name: 'Mine', queries: ['backend'], sources: ['all'] }));
    expect(searchStarted(t.db)).toBe(true);
    expect(tx((x) => setSetupStep(x, 'preferences', 'done'))).toBeNull();
    expect(t.db.select().from(searchPlans).all()).toHaveLength(0);
  });

  it('refuses unknown steps and states, and skipping Preferences', () => {
    expect(parseStep('Import', '')).toEqual({ step: 'import', state: 'done' });
    expect(parseStep('interview', 'later')).toEqual({ step: 'interview', state: 'later' });
    expect(() => parseStep('billing', 'done')).toThrow(SetupError);
    expect(() => parseStep('import', 'maybe')).toThrow(SetupError);
    expect(() => parseStep('preferences', 'skipped')).toThrow(/search starts from them/);
  });

  it('drafts preferences from the CV’s facts, with the lines they come from', () => {
    createProject(t.db, { name: 'Harbor', role: 'Senior Backend Engineer' }, now);
    createProject(t.db, { name: 'Ledgerly', role: 'Backend Engineer' }, now);
    const lead = addFact('Tech Lead for the AI agents platform at Acme', 'role');
    addFact('Built the LLM evaluation harness in Python', 'personal_contribution');
    const langs = addFact('Languages: English (C1), Greek — native, German: basic', 'other');
    addFact('Used PostgreSQL and Redis', 'skill');
    setProfileValue(t.db, 'location', 'Athens, Greece', now);
    setProfileValue(t.db, 'salary_expectation', '€4,500 per month', now);

    const draft = preferencesDraft(t.db);
    const by = Object.fromEntries(draft.map((s) => [s.key, s]));
    expect(by.roles?.value).toBe('backend, ai_ml');
    expect(by.roles?.reason).toContain('"Senior Backend Engineer"');
    expect(by.roles?.factIds).toContain(lead);
    expect(by.seniority).toMatchObject({ value: 'senior, lead', factIds: [lead] });
    expect(by.based_in).toMatchObject({
      value: 'GR',
      reason: 'Your profile\'s location: "Athens, Greece"',
    });
    expect(by.languages).toMatchObject({ value: 'en:C1, de:A1, el:native', factIds: [langs] });
    expect(by.salary?.value).toBe('4500 EUR/month');

    // What the candidate already set isn't drafted again.
    setPreference(t.db, 'roles', ['data'], now);
    expect(preferencesDraft(t.db).map((s) => s.key)).not.toContain('roles');
  });

  it('counts the import’s progress', () => {
    expect(importProgress(t.db)).toEqual({
      sources: 0,
      syncing: 0,
      failed: 0,
      projects: 0,
      facts: 0,
    });
    createProject(t.db, { name: 'Harbor' }, now);
    addFact('Built X', 'personal_contribution');
    expect(importProgress(t.db)).toMatchObject({ projects: 1, facts: 1 });
  });
});
