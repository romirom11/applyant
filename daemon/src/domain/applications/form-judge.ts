// The decisions Read makes about a form, and the values it dry-fills with.
//
//   field_classify  HTML semantics first (autocomplete tokens, input types), then one batched
//                   Jev Choice per snapshot for everything else (fallback claude:haiku)
//   option_match    which option is the candidate's answer: exact / yes-no / whole-word match
//                   first, then Jev (fallback claude:haiku); unsure → no answer
//   values          standard fields from the profile, placeholders for questions. The
//                   candidate's real values matter here: a work-authorisation "No" reveals
//                   different follow-ups than a placeholder "Yes" would.
import type { FillValue } from '../../browser/form-engine.ts';
import type { ReadJudge } from '../../browser/form-read.ts';
import { FIELD_MEANINGS, type FieldMeaning, isFieldMeaning } from '../../browser/form-types.ts';
import type { SnapField } from '../../browser/snapshot.ts';
import type { ChoiceQuestion, Decide } from '../../models/decide.ts';
import { JEV_MAX_OPTIONS } from '../../models/providers/jev.ts';
import type { StandardProfile } from '../knowledge/profile.ts';

export interface FormJudgeOptions {
  decide: Decide;
  profile: StandardProfile;
  /** The posting the form belongs to (context for the decisions). */
  job: { title: string | null; company: string | null };
  taskId: number | null;
  signal: AbortSignal;
  progress?(message: string): void;
}

/** Uploaded only to reach a later step of a wizard; never the candidate's CV. */
export const PLACEHOLDER_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n',
);
export const PLACEHOLDER_TEXT = 'Applyant read placeholder';

const AUTOCOMPLETE: Record<string, FieldMeaning> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  nickname: 'preferred_name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'tel-country-code': 'phone_country',
  country: 'country',
  'country-name': 'country',
  'address-level2': 'city',
  'street-address': 'address',
  'address-line1': 'address',
  organization: 'current_company',
  'organization-title': 'current_title',
};

/** Meanings the HTML itself states; everything else is field_classify's call. */
export function ruleMeaning(f: SnapField): FieldMeaning | null {
  for (const token of f.hint.autocomplete.toLowerCase().split(/\s+/)) {
    const m = AUTOCOMPLETE[token];
    if (m) return m;
  }
  if (f.kind === 'text' && f.hint.type === 'email') return 'email';
  if (f.kind === 'text' && f.hint.type === 'tel') return 'phone';
  return null;
}

/** The profile's value for a standard meaning, or null. */
export function standardValue(meaning: FieldMeaning, p: StandardProfile): string | null {
  const name = p.full_name?.trim() ?? '';
  const words = name.split(/\s+/).filter(Boolean);
  const place = (p.location ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  switch (meaning) {
    case 'full_name':
      return name || null;
    case 'first_name':
    case 'preferred_name':
      return words[0] ?? null;
    case 'last_name':
      return words.length > 1 ? words.slice(1).join(' ') : null;
    case 'email':
      return p.email;
    case 'phone':
      return p.phone;
    case 'location':
      return p.location;
    case 'city':
      return place[0] ?? null;
    case 'country':
    case 'phone_country':
      return place.at(-1) ?? null;
    case 'linkedin':
      return p['links.linkedin'];
    case 'github':
      return p['links.github'];
    case 'website':
      return p['links.website'];
    case 'resume':
      return p.base_cv_file;
    case 'salary':
      return p.salary_expectation;
    case 'notice_period':
      return p.notice_period;
    case 'work_authorization':
      return p.work_authorization;
    case 'visa_sponsorship':
      // Read only needs a plausible branch; Prepare never borrows one answer for the other.
      return p.visa_sponsorship ?? p.work_authorization;
    case 'relocation':
      return p.relocation;
    case 'current_company':
      return p.current_company;
    case 'current_title':
      return p.current_title;
    default:
      return null;
  }
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}+]+/gu, ' ')
    .trim();

const POLAR = /^(yes|no|true|false|none|other|n a|not applicable)$/;

/** A match the code can make without a model, or null. */
export function matchOptionExact(options: string[], answer: string): string | null {
  const a = words(answer);
  if (!a) return null;
  const exact = options.filter((o) => words(o) === a);
  if (exact.length === 1) return exact[0] ?? null;
  const yn = /^(yes|no)\b/.exec(a)?.[1];
  if (yn) {
    const hit = options.filter((o) => words(o) === yn || words(o).startsWith(`${yn} `));
    if (hit.length === 1) return hit[0] ?? null;
  }
  // "Greece" in "Athens, Greece". Never for polar options: "EU citizen, no sponsorship
  // needed" contains "no" but means yes.
  const padded = ` ${a} `;
  const contained = options.filter((o) => {
    const w = words(o);
    if (w.length < 3 || POLAR.test(w)) return false;
    return padded.includes(` ${w} `) || ` ${w} `.includes(padded);
  });
  return contained.length === 1 ? (contained[0] ?? null) : null;
}

const DECLINE = /decline|prefer not|don.?t wish|not to (answer|say|disclose)|rather not/i;

/** The option Read picks when the candidate has no answer on file. */
export function placeholderOption(field: Pick<SnapField, 'options' | 'meaning'>): string | null {
  const options = field.options ?? [];
  if (options.length === 0) return null;
  const decline = options.find((o) => DECLINE.test(o));
  if (
    decline &&
    (field.meaning === 'eeo' || field.meaning === 'pronouns' || field.meaning === null)
  )
    return decline;
  return options.find((o) => o.trim() && !/^other\b/i.test(o)) ?? options[0] ?? null;
}

export function placeholderText(field: SnapField): string {
  switch (field.meaning) {
    case 'email':
      return 'applicant@example.com';
    case 'phone':
      return '+302100000000';
    case 'linkedin':
      return 'https://www.linkedin.com/in/applicant';
    case 'github':
      return 'https://github.com/applicant';
    case 'website':
      return 'https://example.com';
    default:
      break;
  }
  if (field.hint.type === 'number') return '1';
  if (field.hint.type === 'url') return 'https://example.com';
  if (field.hint.type === 'email') return 'applicant@example.com';
  return PLACEHOLDER_TEXT;
}

function shortOptions(options: string[] | null): string[] | null {
  if (!options) return null;
  return options.length > 12
    ? [...options.slice(0, 12), `…and ${options.length - 12} more`]
    : options;
}

export class FormJudge implements ReadJudge {
  private readonly o: FormJudgeOptions;
  private seq = 0;
  /** Decisions about fields asked for this form (logged by read_form). */
  readonly unsure: string[] = [];

  constructor(options: FormJudgeOptions) {
    this.o = options;
  }

  private get state() {
    return {
      document: 'A job application form',
      job: this.o.job.title,
      company: this.o.job.company,
    };
  }

  async classify(fields: SnapField[]): Promise<void> {
    const ask: Record<string, ChoiceQuestion> = {};
    const byId = new Map<string, SnapField>();
    for (const f of fields) {
      const rule = ruleMeaning(f);
      if (rule) {
        f.meaning = rule;
        continue;
      }
      if (!f.label && !f.hint.placeholder && !f.hint.name) continue;
      const id = `f${this.seq++}`;
      byId.set(id, f);
      ask[id] = {
        instructions: {
          field: {
            label: f.label,
            kind: f.kind,
            options: shortOptions(f.options),
            placeholder: f.hint.placeholder || null,
            help: f.hint.description || null,
            html_name: /^[a-z_]+$/i.test(f.hint.name) ? f.hint.name : null,
          },
          question:
            'What does this job application form field ask the applicant for? Pick the closest meaning; custom questions about the applicant are `question`.',
        },
        options: { ...FIELD_MEANINGS },
      };
    }
    if (byId.size === 0) return;
    this.o.progress?.(`classifying ${byId.size} fields`);
    const res = await this.o.decide('field_classify', {
      state: this.state,
      questions: ask,
      taskId: this.o.taskId,
      signal: this.o.signal,
      ...(this.o.progress ? { progress: this.o.progress } : {}),
    });
    for (const [id, f] of byId) {
      const a = res.answers[id];
      if (a?.sure && isFieldMeaning(a.choice)) f.meaning = a.choice;
      else this.unsure.push(f.label);
    }
  }

  /** The option that is the candidate's `answer` to `field`, or null when unsure. */
  async matchOption(field: SnapField, options: string[], answer: string): Promise<string | null> {
    const exact = matchOptionExact(options, answer);
    if (exact) return exact;
    let candidates = [...new Set(options.filter((o) => o.trim()))];
    if (candidates.length === 0) return null;
    if (candidates.length > JEV_MAX_OPTIONS) {
      const a = new Set(words(answer).split(' '));
      candidates = candidates
        .map((o) => ({
          o,
          hits: words(o)
            .split(' ')
            .filter((w) => a.has(w)).length,
        }))
        .sort((x, y) => y.hits - x.hits)
        .slice(0, 50)
        .map((x) => x.o);
    }
    const res = await this.o.decide('option_match', {
      state: this.state,
      questions: {
        match: {
          instructions: {
            form_field: field.label,
            applicants_answer_on_file: answer,
            question:
              "Which option of `form_field` is the applicant's answer, given `applicants_answer_on_file`?",
          },
          options: Object.fromEntries(candidates.map((o) => [o, null])),
        },
      },
      taskId: this.o.taskId,
      signal: this.o.signal,
      ...(this.o.progress ? { progress: this.o.progress } : {}),
    });
    const a = res.answers.match;
    return a?.sure && candidates.includes(a.choice) ? a.choice : null;
  }

  async value(field: SnapField, step: { isFinal: boolean }): Promise<FillValue | undefined> {
    const answer = field.meaning ? standardValue(field.meaning, this.o.profile) : null;
    switch (field.kind) {
      case 'text':
      case 'textarea':
        if (field.value) return { kind: 'skip' };
        return {
          kind: 'text',
          text: field.meaning === 'resume' ? PLACEHOLDER_TEXT : (answer ?? placeholderText(field)),
        };
      case 'date':
        return field.value ? { kind: 'skip' } : { kind: 'text', text: '2026-11-02' };
      case 'select':
      case 'radio': {
        if (!field.options?.length) return undefined;
        const option =
          (answer ? await this.matchOption(field, field.options, answer) : null) ??
          placeholderOption(field);
        return option ? { kind: 'option', option } : undefined;
      }
      case 'combobox': {
        if (field.value) return { kind: 'skip' };
        if (field.options?.length) {
          const option =
            (answer ? await this.matchOption(field, field.options, answer) : null) ??
            placeholderOption(field);
          return option ? { kind: 'option', option } : undefined;
        }
        return {
          kind: 'choose',
          // Something to search for when the candidate has no answer on file.
          text:
            answer ??
            (['location', 'city', 'country'].includes(field.meaning ?? '') ||
            /countr|city|location|where/i.test(field.label)
              ? 'London'
              : 'a'),
          pick: async (options) =>
            (answer ? await this.matchOption(field, options, answer) : null) ??
            placeholderOption({ options, meaning: field.meaning }),
        };
      }
      case 'checkbox': {
        if (field.options && field.options.length > 1) {
          const option =
            (answer ? await this.matchOption(field, field.options, answer) : null) ??
            placeholderOption(field);
          return option ? { kind: 'option', option } : undefined;
        }
        return field.value ? { kind: 'skip' } : { kind: 'check', checked: true };
      }
      case 'file':
        // Only to get past a wizard step that insists on one; never on the final step.
        if (step.isFinal || !field.required) return undefined;
        return {
          kind: 'file',
          file: { name: 'placeholder.pdf', mimeType: 'application/pdf', buffer: PLACEHOLDER_PDF },
        };
      default:
        return undefined;
    }
  }
}
