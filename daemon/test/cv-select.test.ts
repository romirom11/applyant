// What the tailored CV may say: only confirmed facts reach the writer and the plan; lines that
// cite anything else, fail a check, or whose fact stops being confirmed are left out (listed as
// dropped), and skills no confirmed fact names are dropped too.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { facts, postings } from '../src/db/schema.ts';
import {
  applyChecks,
  buildCvContext,
  cvPrompt,
  excludeUnconfirmed,
  factStatuses,
  linesToCheck,
  planFromOutput,
  planIsEmpty,
  validateCvPlan,
  words,
} from '../src/domain/applications/cv/select.ts';
import { createProject } from '../src/domain/knowledge/projects.ts';
import type { CvPlanOutput } from '../src/models/schemas/cv.ts';
import { form, type SeededFacts, seedFacts, seedPosting, spec } from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const now = new Date('2026-09-28T10:00:00Z');

describe('tailored CV content', () => {
  let t: TempDb;
  let f: SeededFacts;
  let postingId: number;
  let teamContext: number;
  let rejected: number;
  let lanternFact: number;

  beforeEach(() => {
    t = tempDb();
    f = seedFacts(t.db, now);
    const add = (
      projectId: number | null,
      text: string,
      status: 'confirmed' | 'rejected',
      kind: 'team_context' | 'personal_contribution' | 'education',
    ) =>
      t.db
        .insert(facts)
        .values({
          projectId,
          text,
          kind,
          status,
          origin: 'extracted',
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: facts.id })
        .get().id;
    teamContext = add(
      f.projectId,
      'The platform team ran the Kafka cluster for the call pipeline',
      'confirmed',
      'team_context',
    );
    rejected = add(
      f.projectId,
      'Designed the whole Harbor architecture alone',
      'rejected',
      'personal_contribution',
    );
    const lantern = createProject(t.db, { name: 'Beacon', period: '2018' }, now);
    lanternFact = add(
      lantern.id,
      'Wrote a Rust CLI for log search',
      'confirmed',
      'personal_contribution',
    );
    add(null, 'BSc in Computer Science, Example University, 2014', 'confirmed', 'education');
    postingId = seedPosting(t.db, form([spec('Resume', 'file', { meaning: 'resume' })]), {
      now,
      matches: [{ text: 'Production Python', factIds: [f.other] }],
    });
  });
  afterEach(() => t.cleanup());

  const posting = () => t.read.select().from(postings).where(eq(postings.id, postingId)).get();

  it('the writer sees confirmed facts only, never team_context, unconfirmed or rejected ones', () => {
    const p = posting();
    if (!p) throw new Error('no posting');
    const ctx = buildCvContext(t.read, p);
    const ids = [...ctx.citable.keys()];
    expect(ids).toContain(f.pipeline);
    expect(ids).toContain(f.oss);
    expect(ids).toContain(lanternFact);
    expect(ids).not.toContain(f.team); // unconfirmed
    expect(ids).not.toContain(rejected);
    expect(ids).not.toContain(teamContext);
    expect(ctx.general.map((x) => x.text)).toEqual([
      'BSc in Computer Science, Example University, 2014',
    ]);

    const prompt = cvPrompt(ctx);
    expect(prompt).toContain('[harbor] Harbor · built project · 2021–2024');
    expect(prompt).toContain(`#${f.pipeline} [personal_contribution · confirmed`);
    expect(prompt).not.toContain('Led a team of 4');
    expect(prompt).not.toContain('Kafka');
    expect(prompt).toContain('Facts tied to no project:');
  });

  it('refuses a plan that cites facts it was not given, or another project’s facts', () => {
    const p = posting();
    if (!p) throw new Error('no posting');
    const ctx = buildCvContext(t.read, p);
    const plan = (bullets: CvPlanOutput['projects'][number]['bullets']): CvPlanOutput => ({
      summary: [],
      projects: [{ project: 'harbor', bullets }],
      education: [],
      skills: [],
    });
    expect(
      validateCvPlan(plan([{ text: 'Built the pipeline', factIds: [f.pipeline] }]), ctx),
    ).toBeNull();
    expect(validateCvPlan(plan([{ text: 'Led a team of 4', factIds: [f.team] }]), ctx)).toMatch(
      new RegExp(`fact #${f.team}, which it was not given`),
    );
    expect(
      validateCvPlan(plan([{ text: 'Wrote a Rust CLI', factIds: [lanternFact] }]), ctx),
    ).toMatch(/another project \(Beacon\)/);
    expect(validateCvPlan(plan([{ text: 'Shipped things', factIds: [] }]), ctx)).toMatch(
      /cites no fact/,
    );
    expect(
      validateCvPlan(
        { summary: [], projects: [{ project: 'nope', bullets: [] }], education: [], skills: [] },
        ctx,
      ),
    ).toMatch(/unknown project "nope"/);
    expect(validateCvPlan({ summary: [], projects: [], education: [], skills: [] }, ctx)).toMatch(
      /no summary and no bullets/,
    );
  });

  it('drops skills no confirmed fact names, lines a check flags, and lines whose fact is no longer confirmed', () => {
    const p = posting();
    if (!p) throw new Error('no posting');
    const ctx = buildCvContext(t.read, p);
    let plan = planFromOutput(
      {
        summary: [
          { text: 'Engineer who builds Python call-analysis pipelines.', factIds: [f.pipeline] },
        ],
        projects: [
          {
            project: 'harbor',
            bullets: [
              { text: 'Built the Python call-analysis pipeline', factIds: [f.pipeline] },
              { text: 'Built a pipeline processing 10 million calls a day', factIds: [f.pipeline] },
              { text: 'Maintains an open-source audio chunking library', factIds: [f.oss] },
            ],
          },
        ],
        education: [],
        // Punctuation around a skill doesn't matter; whole words do.
        skills: ['Python', 'Kubernetes', 'python', '(open-source Python library)', 'Pyth'],
      },
      ctx,
    );
    expect(plan.skills).toEqual(['Python', '(open-source Python library)']);
    expect(plan.dropped).toEqual([
      { section: 'skills', text: 'Kubernetes', factIds: [], reason: 'no confirmed fact names it' },
      { section: 'skills', text: 'Pyth', factIds: [], reason: 'no confirmed fact names it' },
    ]);
    expect(words('Docker, CI/CD (GitHub Actions), AWS; Node.js.')).toBe(
      ' docker ci cd github actions aws node.js ',
    );
    expect(words('Docker, CI/CD (GitHub Actions)').includes(words('CI/CD (GitHub Actions)'))).toBe(
      true,
    );

    const items = linesToCheck(plan, ctx);
    expect(items.map((i) => i.key)).toEqual([
      'summary:0',
      'p:harbor:0',
      'p:harbor:1',
      'p:harbor:2',
    ]);
    expect(items[1]?.facts[0]?.text).toMatch(/call-analysis pipeline/);

    plan = applyChecks(
      plan,
      new Map([
        ['summary:0', { flag: 'none', note: null }],
        ['p:harbor:0', { flag: 'none', note: null }],
        ['p:harbor:1', { flag: 'verifier:quantity', note: 'no fact gives 10 million' }],
        ['p:harbor:2', { flag: 'none', note: null }],
      ]),
    );
    expect(plan.projects[0]?.bullets.map((b) => b.text)).toEqual([
      'Built the Python call-analysis pipeline',
      'Maintains an open-source audio chunking library',
    ]);
    expect(plan.dropped[2]).toMatchObject({
      section: 'harbor',
      text: 'Built a pipeline processing 10 million calls a day',
      reason: 'the verifier: overstates a quantity: no fact gives 10 million',
    });

    // The candidate un-confirms the library fact after the plan was written.
    t.db.update(facts).set({ status: 'unconfirmed' }).where(eq(facts.id, f.oss)).run();
    plan = excludeUnconfirmed(plan, factStatuses(t.db, plan));
    expect(plan.projects[0]?.bullets.map((b) => b.text)).toEqual([
      'Built the Python call-analysis pipeline',
    ]);
    expect(plan.dropped.at(-1)?.reason).toBe(`relies on fact(s) that aren't confirmed: #${f.oss}`);
    expect(planIsEmpty(plan)).toBe(false);

    t.db.update(facts).set({ status: 'rejected' }).where(eq(facts.id, f.pipeline)).run();
    plan = excludeUnconfirmed(plan, factStatuses(t.db, plan));
    expect(planIsEmpty(plan)).toBe(true);
    expect(plan.projects).toEqual([]);
  });
});
