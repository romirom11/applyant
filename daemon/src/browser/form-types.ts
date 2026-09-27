// What the form engine reads from an application form: the TDD's `Requirements` shape.
// Read fills it (phase 4), Prepare answers it (phase 5), Deliver fills the live form from it (6).

/**
 * How to find a control again on a fresh load of the same form.
 *
 *   frame  iframe selectors from the top page down to the form's frame ([] = the page itself)
 *   role · name · nth   getByRole(role, { name, exact: true }).nth(nth) in that frame
 *   css    used instead of role/name when the control isn't addressable by them (hidden file
 *          inputs, unnamed option groups). For option groups it selects the options themselves
 *          (radios, checkboxes or toggle buttons, in order); otherwise the one element.
 */
export interface ElementRef {
  frame: string[];
  role: string;
  name: string;
  nth: number;
  css: string | null;
}

export const FIELD_KINDS = [
  'text',
  'textarea',
  'select',
  'combobox',
  'radio',
  'checkbox',
  'file',
  'date',
  /**
   * A repeatable section ("Education", "Experience"): its ref is the control that adds an
   * entry, and the entry's fields are listed with revealedBy { ref: that control, value: "add" }.
   */
  'group',
  'unknown',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * What a field asks for (field_classify). Standard meanings are filled from the candidate's
 * profile; `question` is answered by the application writer; `eeo` and `consent` are the
 * candidate's own call.
 */
export const FIELD_MEANINGS = {
  first_name: "The applicant's first (given) name",
  last_name: "The applicant's last (family) name",
  full_name: "The applicant's full name in one field",
  preferred_name: 'A preferred name or nickname to be called by',
  email: 'Email address',
  phone: 'Phone number',
  phone_country: 'Country or dialling code of the phone number',
  location:
    'Where the applicant lives or will work from: a city and/or country, or a location search',
  country: 'Country of residence, on its own',
  city: 'City of residence, on its own',
  address: 'Postal or street address',
  linkedin: 'LinkedIn profile URL',
  github: 'GitHub profile URL',
  website: 'Personal website, portfolio or another profile URL',
  resume: 'Resume or CV (a file upload or pasted text)',
  cover_letter: 'Cover letter (a file upload or pasted text)',
  salary: 'Salary expectations or desired compensation',
  notice_period: 'Notice period, availability or earliest start date',
  work_authorization:
    'Whether the applicant is legally allowed or eligible to work in the country or region',
  visa_sponsorship: 'Whether the applicant needs visa or work-permit sponsorship',
  relocation: 'Whether the applicant is willing to relocate',
  current_company: 'Current employer',
  current_title: 'Current job title',
  education: 'Education history: schools, degrees, fields of study',
  experience: 'Work history: previous employers, titles and dates',
  pronouns: 'Pronouns',
  eeo: 'Voluntary demographic or equal-opportunity survey: gender, race, ethnicity, age, veteran status, disability',
  how_heard: 'How the applicant heard about the job, or who referred them',
  consent: 'Consent to a privacy notice, data processing or terms',
  question:
    "Any other question about the applicant's experience, skills, motivation, preferences or situation",
  other: 'Anything else (not a question for the applicant)',
} as const;
export type FieldMeaning = keyof typeof FIELD_MEANINGS;
export const FIELD_MEANING_KEYS = Object.keys(FIELD_MEANINGS) as FieldMeaning[];

export function isFieldMeaning(value: string): value is FieldMeaning {
  return Object.hasOwn(FIELD_MEANINGS, value);
}

/**
 * `value` is the option (or "checked") that revealed the field; "*" = any answer did; "add" = it
 * belongs to an entry of a repeatable group, shown once the group's add control is pressed.
 */
export interface RevealedBy {
  ref: ElementRef;
  value: string;
}

export interface FieldSpec {
  ref: ElementRef;
  label: string;
  kind: FieldKind;
  /**
   * The page requires it whenever it is shown: for a conditional field, only on the branch in
   * `revealedBy` (Lever requires the disability signature only once the question is answered).
   */
  required: boolean;
  /** Choices for select / radio / checkbox groups / comboboxes; null when free or unknown. */
  options: string[] | null;
  meaning: FieldMeaning | null;
  revealedBy: RevealedBy | null;
}

export interface FormStep {
  fields: FieldSpec[];
  /** The control that moves to the next step, or submits on the final step. */
  advance: ElementRef | null;
  /** The advance control submits the application. Read never presses it. */
  isFinal: boolean;
}

export interface Requirements {
  steps: FormStep[];
}

/** One Read of an application form. Stored on the posting. */
export interface FormRead {
  /** Where the form was read (after following the apply link). */
  url: string;
  requirements: Requirements;
  /** What Read couldn't do or noticed: a step it couldn't pass, options that load as you type. */
  notes: string[];
}

export function refKey(ref: ElementRef): string {
  return `${ref.frame.join(' >> ')}|${ref.css ?? `${ref.role}:${ref.name}#${ref.nth}`}`;
}

export function fieldCount(req: Requirements): { fields: number; required: number } {
  let fields = 0;
  let required = 0;
  for (const step of req.steps) {
    for (const f of step.fields) {
      fields++;
      if (f.required) required++;
    }
  }
  return { fields, required };
}
