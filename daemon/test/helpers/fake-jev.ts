// A scripted Jev for tests: field_classify questions are answered from label rules,
// option_match questions from a function, anything else from `other`. Every request is kept.
import type { FieldMeaning } from '../../src/browser/form-types.ts';
import type { JevChoiceAnswer, JevRequest, JevResponse } from '../../src/models/providers/jev.ts';

export interface FakeJevOptions {
  /** field_classify: first matching label rule wins; no match → `question`. */
  meanings?: Array<[RegExp, FieldMeaning]>;
  /** option_match: the option for (field label, answer on file, options), or null (unsure). */
  match?: (label: string, answer: string, options: string[]) => string | null;
  confidence?: number;
}

/** Label rules that cover the fixture forms. */
export const FIXTURE_MEANINGS: Array<[RegExp, FieldMeaning]> = [
  [/^(first name|given name)/i, 'first_name'],
  [/^(last name|family name)/i, 'last_name'],
  [/^(full )?name\b/i, 'full_name'],
  [/e-?mail/i, 'email'],
  [/phone/i, 'phone'],
  [/resume|\bcv\b/i, 'resume'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/website|portfolio url/i, 'website'],
  [/authori[sz]ed to work|eligible to work/i, 'work_authorization'],
  [/sponsorship/i, 'visa_sponsorship'],
  [/^country\b|which country/i, 'country'],
  [/location|\bcity\b/i, 'location'],
  [/salary/i, 'salary'],
  [/gender|ethnicit|race|age\?|hispanic|veteran|disability/i, 'eeo'],
  [/hear about/i, 'how_heard'],
  [/privacy|certify|consent|agree to/i, 'consent'],
];

export function fakeJev(o: FakeJevOptions = {}) {
  const requests: JevRequest[] = [];
  const confidence = o.confidence ?? 0.95;
  return {
    requests,
    async available() {
      return true;
    },
    async ask(req: JevRequest): Promise<JevResponse> {
      requests.push(req);
      const answers: Record<string, JevChoiceAnswer> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const ins = (typeof q.instructions === 'object' ? q.instructions : {}) as Record<
          string,
          unknown
        >;
        const options = Object.keys(q.criteria);
        let choice: string | null = null;
        const field = ins.field as { label?: string } | undefined;
        if (field) {
          const label = field.label ?? '';
          choice = o.meanings?.find(([re]) => re.test(label))?.[1] ?? 'question';
        } else if (typeof ins.applicants_answer_on_file === 'string') {
          choice =
            o.match?.(String(ins.form_field ?? ''), ins.applicants_answer_on_file, options) ?? null;
        }
        if (!choice || !options.includes(choice)) {
          const first = options[0] ?? '';
          answers[id] = { type: 'choice', choice: first, confidence: 0.2, probabilities: {} };
          continue;
        }
        answers[id] = {
          type: 'choice',
          choice,
          confidence,
          probabilities: { [choice]: confidence },
        };
      }
      return { model: 'jev-fake', answers, usage: { input_tokens: 100, output_tokens: 0 } };
    },
  };
}
