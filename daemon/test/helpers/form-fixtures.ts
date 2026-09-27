// Recorded application forms: test/fixtures/forms/<name>/{page.har.zip, fixture.json}.
//
//   page.har.zip   what the browser fetched while Read ran (Playwright HAR, minimal mode)
//   fixture.json   the URL, the synthetic profile Read used, every field_classify / option_match
//                  decision it got (keyed by question content), and the expected FormRead
//
// Replay serves the page from the HAR with routeFromHAR (no network: anything missing is
// aborted) and answers decisions from the recording (no model), so a change to the reader is
// checked against every recorded form offline.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import type { FormRead } from '../../src/browser/form-types.ts';
import type { StandardProfile } from '../../src/domain/knowledge/profile.ts';
import type { ChoiceQuestion, Decide, Decision } from '../../src/models/decide.ts';
import type { Role } from '../../src/models/roles.ts';
import { runRead } from './form-read.ts';

export const FORMS_DIR = fileURLToPath(new URL('../fixtures/forms', import.meta.url));

export interface FormFixture {
  name: string;
  url: string;
  /** public: recorded from a real, public application form (read only, never submitted) ·
   *  synthetic: a local page modelled on an ATS. */
  source: 'public' | 'synthetic';
  /** What the form is, e.g. "Greenhouse job board (job-boards.greenhouse.io)". */
  about: string;
  recordedAt: string;
  profile: StandardProfile;
  decisions: Record<string, Decision>;
  expected: FormRead;
}

export function decisionKey(role: Role, state: unknown, q: ChoiceQuestion): string {
  return createHash('sha256')
    .update(JSON.stringify([role, state, q.instructions, q.options]))
    .digest('hex')
    .slice(0, 20);
}

/** Wraps a Decide and keeps every answer under its question's key. */
export function recordingDecide(inner: Decide, into: Record<string, Decision>): Decide {
  return async (role, req) => {
    const res = await inner(role, req);
    for (const [id, q] of Object.entries(req.questions)) {
      const a = res.answers[id];
      if (a) into[decisionKey(role, req.state, q)] = a;
    }
    return res;
  };
}

/** Answers from a recording; questions it doesn't have are listed in `misses`. */
export function replayDecide(decisions: Record<string, Decision>, misses: string[]): Decide {
  return async (role, req) => {
    const answers: Record<string, Decision> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const a = decisions[decisionKey(role, req.state, q)];
      if (a) answers[id] = a;
      else misses.push(`${role}: ${JSON.stringify(q.instructions).slice(0, 120)}`);
    }
    return { answers, problems: [], limit: null };
  };
}

export function listFixtures(): Array<{ dir: string; fixture: FormFixture }> {
  if (!existsSync(FORMS_DIR)) return [];
  return readdirSync(FORMS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FORMS_DIR, d.name, 'fixture.json')))
    .map((d) => ({
      dir: join(FORMS_DIR, d.name),
      fixture: JSON.parse(
        readFileSync(join(FORMS_DIR, d.name, 'fixture.json'), 'utf8'),
      ) as FormFixture,
    }));
}

export interface Replay {
  read: FormRead;
  misses: string[];
  blocked: string[];
}

/** Reads a recorded form offline: HAR for the network, the recording for decisions. */
export async function replayFixture(
  browser: Browser,
  dir: string,
  fixture: FormFixture,
): Promise<Replay> {
  const misses: string[] = [];
  const run = await runRead(browser, fixture.url, {
    profile: fixture.profile,
    decide: replayDecide(fixture.decisions, misses),
    prepare: async (context) => {
      await context.routeFromHAR(join(dir, 'page.har.zip'), { notFound: 'abort' });
    },
  });
  try {
    return { read: run.read, misses, blocked: run.blocked };
  } finally {
    await run.close();
  }
}
