// Every role schema must convert to the JSON Schema subset both SDKs accept. Codex's strict
// mode is the narrower one: every property required, additionalProperties false, and no
// refinement keywords (minimum, minLength, format, pattern, ...). Such constraints belong in
// the post-parse `validate` step instead.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toStrictJsonSchema } from '../src/models/agent-runner.ts';
import { ROLE_SCHEMAS } from '../src/models/schemas/index.ts';

const ALLOWED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
]);

interface Problem {
  path: string;
  problem: string;
}

function check(node: unknown, path: string, out: Problem[]): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => {
      check(n, `${path}[${i}]`, out);
    });
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED.has(key)) out.push({ path, problem: `keyword "${key}" is not allowed` });
  }
  const types = Array.isArray(obj.type) ? obj.type : [obj.type];
  if (types.includes('object')) {
    const props = Object.keys((obj.properties as Record<string, unknown>) ?? {});
    if (obj.additionalProperties !== false) {
      out.push({ path, problem: 'object without additionalProperties: false (use .strict())' });
    }
    const required = new Set((obj.required as string[]) ?? []);
    for (const p of props) {
      if (!required.has(p)) {
        out.push({ path: `${path}.${p}`, problem: 'optional property (use .nullable())' });
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) check(sub, `${path}.${name}`, out);
    } else if (key === 'items' || key === 'anyOf') {
      check(value, `${path}.${key}`, out);
    }
  }
}

function problems(schema: z.ZodType): Problem[] {
  const out: Problem[] = [];
  check(toStrictJsonSchema(schema), '$', out);
  return out;
}

describe('role output schemas are strict', () => {
  it('has schemas to check', () => {
    expect(Object.keys(ROLE_SCHEMAS).length).toBeGreaterThan(0);
  });

  for (const [name, schema] of Object.entries(ROLE_SCHEMAS)) {
    it(name, () => {
      expect(problems(schema)).toEqual([]);
    });
  }

  it('catches optional fields, loose objects and refinements', () => {
    const loose = z.looseObject({
      a: z.string().optional(),
      b: z.number().int().min(1),
      c: z.string().email(),
      d: z.looseObject({ e: z.string() }),
    });
    const found = problems(loose).map((p) => `${p.path}: ${p.problem}`);
    expect(found).toEqual(
      expect.arrayContaining([
        '$: object without additionalProperties: false (use .strict())',
        '$.a: optional property (use .nullable())',
        expect.stringMatching(/^\$\.b: keyword "(minimum|exclusiveMinimum)"/),
        expect.stringMatching(/^\$\.c: keyword "(format|pattern)"/),
        '$.d: object without additionalProperties: false (use .strict())',
      ]),
    );
  });
});
