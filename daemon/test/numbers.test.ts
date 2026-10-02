// The deterministic number & date check: contradictions are hard flags, numbers the facts
// don't have are confirmable, and unrelated numbers never read as contradictions.

import { describe, expect, it } from 'vitest';
import { checkNumbers, extractQuantities } from '../src/domain/applications/checks/numbers.ts';
import { answerCheckPrompt } from '../src/domain/applications/checks/verify.ts';

const fact = (id: number, text: string, period: string | null = null) => ({ id, text, period });

describe('extractQuantities', () => {
  it('reads team sizes, durations, scale, percentages, money and dates', () => {
    const q = extractQuantities(
      'Led a team of 4 engineers for 5+ years, handling 20k calls a day, cut latency by 40%, raised $2M in 2023',
    );
    expect(q.map((x) => [x.kind, x.value, x.key, x.atLeast])).toEqual([
      ['money', 2_000_000, 'raised', false],
      ['percent', 40, 'latency', false],
      ['years', 5, null, true],
      ['people', 4, 'team', false],
      ['count', 20_000, 'call', false],
      ['year', 2023, null, false],
    ]);
  });

  it('reads number words, ranges and "N-person team"', () => {
    const q = extractQuantities('a four-person team from 2019–2024, with twelve services');
    expect(q.map((x) => [x.kind, x.value, x.until ?? null, x.key])).toEqual([
      ['year', 2019, 2024, null],
      ['people', 4, null, 'team'],
      ['count', 12, null, 'service'],
    ]);
  });

  it('ignores versions, ids and times', () => {
    expect(extractQuantities('Upgraded to Python 3.12 in PR #42 at 10:30 on v2')).toEqual([]);
  });
});

describe('checkNumbers', () => {
  it('"team of 10" against a fact saying "team of 4" is a contradiction', () => {
    const res = checkNumbers('I led a team of 10 engineers building the platform.', [
      fact(7, 'Led a team of 4 engineers on the call-analysis platform'),
    ]);
    expect(res).toMatchObject({
      kind: 'contradiction',
      factId: 7,
      sentence: { kind: 'people', value: 10 },
      fact: { kind: 'people', value: 4 },
    });
  });

  it('"5+ years" derived from a 2019–2024 period is absent (confirmable), not a contradiction', () => {
    const res = checkNumbers('I have 5+ years of backend experience.', [
      fact(3, 'Built the billing backend', '2019–2024'),
    ]);
    expect(res).toMatchObject({ kind: 'absent', quantities: [{ kind: 'years', value: 5 }] });
  });

  it('numbers the facts state are fine, in any spelling', () => {
    expect(
      checkNumbers('The pipeline handles 20,000 calls a day.', [
        fact(1, 'Pipeline processes ~20k calls daily'),
      ]),
    ).toEqual({ kind: 'ok' });
    expect(
      checkNumbers('I worked there in 2021.', [fact(1, 'Backend lead at Acme', '2019–2024')]),
    ).toEqual({ kind: 'ok' });
    expect(
      checkNumbers('I have 3+ years of Python.', [fact(1, 'Wrote Python for 5 years at Acme')]),
    ).toEqual({ kind: 'ok' });
  });

  it('an unrelated number in another fact is not a contradiction', () => {
    const res = checkNumbers('I cut latency by 40%.', [
      fact(1, 'Reduced infrastructure costs by 30%'),
      fact(2, 'Cut p95 latency by 40% with caching'),
    ]);
    expect(res).toEqual({ kind: 'ok' });
    const other = checkNumbers('I cut latency by 25%.', [fact(1, 'Reduced costs by 30%')]);
    expect(other.kind).toBe('absent');
  });

  it('one agreeing fact settles it even when another has a different team size', () => {
    const res = checkNumbers('I led a team of 4.', [
      fact(1, 'The company had a team of 40 engineers'),
      fact(2, 'Led a team of 4 on payments'),
    ]);
    expect(res).toEqual({ kind: 'ok' });
  });

  it('an "at least" fact does not contradict a larger number (it is only absent)', () => {
    const res = checkNumbers('I have 8 years of Go.', [fact(1, '5+ years of Go in production')]);
    expect(res.kind).toBe('absent');
  });

  it('numbers from the candidate’s own profile values need no fact', () => {
    expect(
      checkNumbers('I can start within 1 month.', [], ['1 month', '60000 EUR per year']),
    ).toEqual({ kind: 'ok' });
  });

  it("repeats the employer's own numbers, never as the candidate's years or team", () => {
    const posting = 'We serve 270 merchants and want 5+ years of Python in a team of 8.';
    const facts = [{ id: 1, text: 'Built a Laravel B2B portal' }];
    expect(
      checkNumbers('Excited to help you grow past 270 merchants.', facts, [], [posting]).kind,
    ).toBe('ok');
    expect(checkNumbers('I have 5+ years of Python.', facts, [], [posting]).kind).toBe('absent');
    expect(checkNumbers('I led a team of 8.', facts, [], [posting]).kind).toBe('absent');
  });

  it('the verifier sees the project and role with each fact', () => {
    const prompt = answerCheckPrompt([
      {
        key: '1',
        text: 'As Tech Lead I shipped an AI sales assistant.',
        facts: [
          {
            id: 6,
            text: 'Shipped an AI sales assistant',
            period: 'Jul 2025 – May 2026',
            project: 'Tech Lead at NDA; role: Tech Lead',
          },
        ],
      },
    ]);
    expect(prompt).toContain(
      '#6: Shipped an AI sales assistant (project: Tech Lead at NDA; role: Tech Lead; period: Jul 2025 – May 2026)',
    );
  });
});
