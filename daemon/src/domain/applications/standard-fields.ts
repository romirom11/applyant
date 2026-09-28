// Standard fields: what the form asks for (field_classify's meaning) → the candidate's profile
// value, which is a default for this application and can be overridden for it.
//
// Rules that keep a loose classification from putting a profile value in the wrong place:
//   · fields of a repeatable group's entry (revealedBy "add") are filled by their group,
//     never one by one by their label (Workable's entry "Start date" is not a notice period)
//   · a link goes only where the label doesn't name something else ("Video link URL")
//   · a date field never gets free text ("1 month" isn't a date)
//   · yes/no-type answers (work authorisation, sponsorship, relocation) are matched to the
//     options by option_match with the field's own wording and a "doesn't settle it" way out:
//     "EU citizen" doesn't answer "Are you eligible to work in the United States?"
//   · visa sponsorship is its own value, never borrowed from work authorisation
//   · anything the profile doesn't have stays empty; a required one becomes something the
//     candidate has to give (needs_candidate), never a guess
//
// Consent is given by approving the application; a required demographic question is answered
// with its "decline to answer" option (neither is a candidate value). Optional demographic and
// custom questions are left empty.
import {
  type FieldMeaning,
  type FieldSpec,
  type FormRead,
  refKey,
} from '../../browser/form-types.ts';
import type { FieldSource } from '../../db/schema.ts';
import type { ChoiceQuestion, Decide } from '../../models/decide.ts';
import { JEV_MAX_OPTIONS } from '../../models/providers/jev.ts';
import type { StandardKey, StandardProfile } from '../knowledge/profile.ts';
import { matchOptionExact } from './form-judge.ts';

/** How a field gets its value. */
export type FieldRole =
  /** From the profile (or nothing). */
  | 'standard'
  /** Written by application_writer. */
  | 'question'
  /** A repeatable section: its value is its entries (JSON); none by default. */
  | 'group'
  /** A field of a group's entry: filled by its group. */
  | 'entry'
  | 'consent'
  | 'eeo';

/** A form field as Prepare handles it: flattened across steps, with a stable ref. */
export interface FormField {
  /** `<step>:<refKey>` (`~2` appended for a second field on the same control). */
  ref: string;
  step: number;
  position: number;
  spec: FieldSpec;
}

export interface FieldDefault {
  value: string | null;
  source: FieldSource;
  note: string | null;
}

const WRITTEN = new Set<FieldMeaning>(['question', 'other']);

export function fieldRole(spec: FieldSpec): FieldRole {
  if (spec.revealedBy?.value === 'add') return 'entry';
  if (spec.kind === 'group') return 'group';
  if (spec.meaning === 'consent') return 'consent';
  if (spec.meaning === 'eeo') return 'eeo';
  if (spec.meaning === null || WRITTEN.has(spec.meaning)) return 'question';
  if (spec.meaning === 'cover_letter' && (spec.kind === 'textarea' || spec.kind === 'text')) {
    return 'question';
  }
  return 'standard';
}

export function formFields(read: FormRead): FormField[] {
  const out: FormField[] = [];
  const seen = new Map<string, number>();
  read.requirements.steps.forEach((step, s) => {
    for (const spec of step.fields) {
      const base = `${s + 1}:${refKey(spec.ref)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      out.push({ ref: n === 1 ? base : `${base}~${n}`, step: s + 1, position: out.length, spec });
    }
  });
  return out;
}

// ---- values -------------------------------------------------------------------------------

/** Does a value satisfy a revealedBy condition ("*", "checked", "add", an option)? */
export function satisfies(spec: FieldSpec, value: string | null, want: string): boolean {
  if (value === null || value === '') return false;
  if (want === 'add') return spec.kind === 'group' && entries(value).length > 0;
  if (want === '*') return value !== 'unchecked' && value !== '[]';
  if (want === 'checked' || want === 'unchecked') return value === want;
  const norm = (v: string) => v.trim().toLowerCase();
  return optionList(value).some((v) => norm(v) === norm(want));
}

/** A multi-choice value is a JSON array of options; anything else is one option. */
export function optionList(value: string): string[] {
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // A value that merely starts with "[" is one option.
    }
  }
  return [value];
}

/** A group's value: JSON array of entries (label → value). */
export function entries(value: string | null): Array<Record<string, string>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, string>>) : [];
  } catch {
    return [];
  }
}

export interface Valued {
  ref: string;
  step: number;
  spec: FieldSpec;
  value: string | null;
}

/**
 * The fields the form will actually show, given the values: a conditional field applies only
 * when the field that reveals it applies and has the revealing value; an entry field only when
 * its group has entries. Questions revealed by a question count as applying while that question
 * has no value yet (`pendingQuestions`): the writer answers both and the condition decides.
 */
export function activeRefs(fields: Valued[], pendingQuestions = false): Set<string> {
  const active = new Set<string>();
  const byControl = new Map<string, Valued>();
  for (const f of fields) {
    const k = `${f.step}:${refKey(f.spec.ref)}`;
    if (!byControl.has(k) && f.spec.revealedBy?.value !== 'add') byControl.set(k, f);
  }
  for (const f of fields) {
    const by = f.spec.revealedBy;
    if (!by) {
      active.add(f.ref);
      continue;
    }
    const revealer = byControl.get(`${f.step}:${refKey(by.ref)}`);
    if (!revealer || !active.has(revealer.ref)) continue;
    if (by.value === 'add') {
      if (revealer.spec.kind === 'group' && entries(revealer.value).length > 0) active.add(f.ref);
      continue;
    }
    if (satisfies(revealer.spec, revealer.value, by.value)) active.add(f.ref);
    else if (
      pendingQuestions &&
      revealer.value === null &&
      fieldRole(revealer.spec) === 'question'
    ) {
      active.add(f.ref);
    }
  }
  return active;
}

const DECLINE = /decline|prefer not|don.?t wish|not to (answer|say|disclose)|rather not/i;
const AFFIRM =
  /^(yes|i agree|agree|i accept|accept|i confirm|confirm|i consent|consent|i have read|i understand)\b/i;
const POLAR_MEANINGS = new Set<FieldMeaning>([
  'work_authorization',
  'visa_sponsorship',
  'relocation',
]);

/** Which profile key a meaning comes from. */
const KEY_FOR: Partial<Record<FieldMeaning, StandardKey>> = {
  email: 'email',
  phone: 'phone',
  location: 'location',
  linkedin: 'links.linkedin',
  github: 'links.github',
  website: 'links.website',
  resume: 'base_cv_file',
  salary: 'salary_expectation',
  notice_period: 'notice_period',
  work_authorization: 'work_authorization',
  visa_sponsorship: 'visa_sponsorship',
  relocation: 'relocation',
  current_company: 'current_company',
  current_title: 'current_title',
};

/** Why a link meaning doesn't fit the label (Jev's classification can be loose). */
function labelConflict(meaning: FieldMeaning, label: string): boolean {
  const l = label.toLowerCase();
  switch (meaning) {
    case 'website':
      return /video|youtube|loom|vimeo|linked\s*in|github|twitter|x\.com|dribbble|behance/.test(l);
    case 'linkedin':
      return /github|video|twitter|website|portfolio/.test(l) && !/linked\s*in/.test(l);
    case 'github':
      return /linked\s*in|video|twitter|gitlab|bitbucket/.test(l) && !/github/.test(l);
    default:
      return false;
  }
}

/** The dialling code of a phone number in international form ("+30 210…" → "30"). */
export function dialCode(phone: string | null): string | null {
  const m = /^\s*(?:\+|00)(\d{1,3})/.exec(phone ?? '');
  return m?.[1] ?? null;
}

const looksLikeDialCodes = (options: string[]) =>
  options.filter((o) => /\+\s?\d{1,3}\b/.test(o)).length >= Math.max(2, options.length * 0.5);

/** The profile text for a meaning (derivations only: parts of the name or the location). */
export function profileText(
  meaning: FieldMeaning,
  spec: FieldSpec,
  p: StandardProfile,
): { value: string | null; key: string } {
  const name = p.full_name?.trim() ?? '';
  const words = name.split(/\s+/).filter(Boolean);
  const place = (p.location ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  switch (meaning) {
    case 'full_name':
      return { value: name || null, key: 'full_name' };
    case 'first_name':
    case 'preferred_name':
      return { value: words[0] ?? null, key: 'full_name' };
    case 'last_name':
      return { value: words.length > 1 ? words.slice(1).join(' ') : null, key: 'full_name' };
    case 'city':
      return { value: place.length ? (place[0] ?? null) : null, key: 'location' };
    case 'country':
    case 'phone_country':
      return { value: place.at(-1) ?? null, key: 'location' };
    case 'location': {
      // "Location (city, country)" asks for both: the whole location, not one part of it.
      const country = /\bcountry\b/i.test(spec.label);
      const city = /\bcity\b/i.test(spec.label);
      if (country && !city) return { value: place.at(-1) ?? null, key: 'location' };
      if (city && !country) return { value: place[0] ?? null, key: 'location' };
      return { value: p.location, key: 'location' };
    }
    default: {
      const key = KEY_FOR[meaning];
      return { value: key ? p[key] : null, key: key ?? meaning };
    }
  }
}

export interface StandardFieldsOptions {
  decide: Decide;
  profile: StandardProfile;
  job: { title: string | null; company: string | null };
  taskId: number | null;
  signal: AbortSignal;
  progress?(message: string): void;
}

export interface StandardFieldsResult {
  defaults: Map<string, FieldDefault>;
  /** The option_match fallback hit a subscription limit. */
  limit: { provider: string; until: Date } | null;
}

const NONE_OF_THESE = '__none__';

/** Default values for every field that isn't a question (questions are the writer's). */
export async function prepareStandardFields(
  fields: FormField[],
  o: StandardFieldsOptions,
): Promise<StandardFieldsResult> {
  const defaults = new Map<string, FieldDefault>();
  const none = (note: string | null): FieldDefault => ({ value: null, source: 'none', note });
  const ask: Record<string, ChoiceQuestion> = {};
  const asked = new Map<
    string,
    { field: FormField; answer: string; key: string; options: string[] }
  >();
  const p = o.profile;

  for (const field of fields) {
    const { spec } = field;
    const options = spec.options ?? [];
    switch (fieldRole(spec)) {
      case 'question':
        continue;
      case 'entry':
        defaults.set(field.ref, none('part of an entry of its group'));
        continue;
      case 'group':
        defaults.set(field.ref, none(spec.required ? null : 'no entries (optional)'));
        continue;
      case 'consent': {
        if (spec.kind === 'checkbox' && options.length <= 1) {
          defaults.set(field.ref, {
            value: 'checked',
            source: 'rule',
            note: 'consent: given by approving',
          });
        } else {
          const yes = options.find((opt) => AFFIRM.test(opt.trim()));
          defaults.set(
            field.ref,
            yes
              ? { value: yes, source: 'rule', note: 'consent: given by approving' }
              : none('a consent question without a clear "yes" option'),
          );
        }
        continue;
      }
      case 'eeo': {
        if (!spec.required) {
          defaults.set(field.ref, none('demographic question: yours to answer (optional)'));
          continue;
        }
        const decline = options.find((opt) => DECLINE.test(opt));
        defaults.set(
          field.ref,
          decline
            ? { value: decline, source: 'rule', note: 'declined to self-identify' }
            : none('a required demographic question: yours to answer'),
        );
        continue;
      }
      case 'standard':
        break;
    }

    const meaning = spec.meaning as FieldMeaning;
    const { value: text, key } = profileText(meaning, spec, p);
    if (labelConflict(meaning, spec.label)) {
      defaults.set(field.ref, none(`the label doesn't look like your ${key}`));
      continue;
    }
    if (spec.kind === 'file') {
      if (meaning === 'resume' && p.base_cv_file) {
        defaults.set(field.ref, { value: p.base_cv_file, source: 'file', note: 'your base CV' });
      } else {
        defaults.set(
          field.ref,
          none(meaning === 'resume' ? 'no base_cv_file in your profile' : null),
        );
      }
      continue;
    }
    if (spec.kind === 'date' || (meaning === 'notice_period' && /\bdate\b/i.test(spec.label))) {
      defaults.set(field.ref, none('asks for a date: give it for this application'));
      continue;
    }
    if (spec.kind === 'checkbox' && options.length <= 1) {
      defaults.set(field.ref, none(null));
      continue;
    }
    const choice =
      spec.kind === 'select' ||
      spec.kind === 'radio' ||
      spec.kind === 'checkbox' ||
      (spec.kind === 'combobox' && options.length > 0);

    // Dialling-code lists ("Greece +30"): the code of the profile phone decides.
    if (
      choice &&
      ['phone', 'phone_country', 'country'].includes(meaning) &&
      looksLikeDialCodes(options)
    ) {
      const code = dialCode(p.phone);
      const hits = code ? options.filter((opt) => new RegExp(`\\+\\s?${code}\\b`).test(opt)) : [];
      const country = profileText('country', spec, p).value;
      const pick =
        hits.length === 1
          ? hits[0]
          : hits.find((h) => country && h.toLowerCase().includes(country.toLowerCase()));
      defaults.set(
        field.ref,
        pick
          ? { value: pick, source: 'profile', note: `from your phone number's code (+${code})` }
          : none(
              code ? `no single option for +${code}` : 'no international code in your phone number',
            ),
      );
      continue;
    }
    if (text === null) {
      defaults.set(field.ref, none(`no ${key} in your profile`));
      continue;
    }
    if (!choice) {
      defaults.set(field.ref, { value: text, source: 'profile', note: null });
      continue;
    }
    if (!POLAR_MEANINGS.has(meaning)) {
      const exact = matchOptionExact(options, text);
      if (exact) {
        defaults.set(field.ref, { value: exact, source: 'profile', note: null });
        continue;
      }
    }
    let candidates = [...new Set(options.filter((opt) => opt.trim()))];
    if (candidates.length === 0) {
      defaults.set(field.ref, none('no options to choose from'));
      continue;
    }
    if (candidates.length >= JEV_MAX_OPTIONS) {
      const a = new Set(text.toLowerCase().split(/\W+/));
      candidates = candidates
        .map((c) => ({
          c,
          hits: c
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => a.has(w)).length,
        }))
        .sort((x, y) => y.hits - x.hits)
        .slice(0, 50)
        .map((x) => x.c);
    }
    const id = `o${asked.size}`;
    asked.set(id, { field, answer: text, key, options: candidates });
    ask[id] = {
      instructions: {
        form_field: spec.label,
        applicants_answer_on_file: text,
        question:
          "Which option of `form_field` is the applicant's answer, going only by `applicants_answer_on_file`? If that answer doesn't settle the question as the form asks it (a different country or region, a different question), choose __none__.",
      },
      options: {
        ...Object.fromEntries(candidates.map((c) => [c, null])),
        [NONE_OF_THESE]: "The answer on file doesn't settle this question",
      },
    };
  }

  let limit: StandardFieldsResult['limit'] = null;
  if (asked.size > 0) {
    o.progress?.(`matching ${asked.size} profile answers to options`);
    const res = await o.decide('option_match', {
      state: {
        document: 'A job application form',
        job: o.job.title,
        company: o.job.company,
      },
      questions: ask,
      taskId: o.taskId,
      signal: o.signal,
      ...(o.progress ? { progress: o.progress } : {}),
    });
    limit = res.limit;
    for (const [id, a] of asked) {
      const answer = res.answers[id];
      if (answer?.sure && answer.choice !== NONE_OF_THESE && a.options.includes(answer.choice)) {
        defaults.set(a.field.ref, {
          value: answer.choice,
          source: 'profile',
          note: `your ${a.key} "${truncate(a.answer, 60)}" → this option (${answer.by})`,
        });
      } else {
        defaults.set(
          a.field.ref,
          none(
            answer?.sure
              ? `your ${a.key} "${truncate(a.answer, 60)}" doesn't settle this question`
              : `couldn't match your ${a.key} "${truncate(a.answer, 60)}" to an option`,
          ),
        );
      }
    }
  }
  return { defaults, limit };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
