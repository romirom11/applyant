// The pure pieces of the form engine: which control advances a step (and whether it submits),
// what the read-only guard lets through, option matching, profile values.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickAdvance } from '../src/browser/form-engine.ts';
import { isGraphqlQuery } from '../src/browser/form-read.ts';
import type { ElementRef } from '../src/browser/form-types.ts';
import { parseAriaLine, type SnapButton } from '../src/browser/snapshot.ts';
import {
  matchOptionExact,
  placeholderOption,
  standardValue,
} from '../src/domain/applications/form-judge.ts';
import {
  parseProfileValue,
  STANDARD_KEYS,
  type StandardProfile,
} from '../src/domain/knowledge/profile.ts';

const ref = (name: string): ElementRef => ({ frame: [], role: 'button', name, nth: 0, css: null });
const button = (text: string, o: Partial<SnapButton> = {}): SnapButton => ({
  ref: ref(text),
  text,
  submit: false,
  inRoot: true,
  ...o,
});

describe('pickAdvance', () => {
  it('"Next"-like controls advance; anything that could submit is final', () => {
    expect(pickAdvance([button('Back'), button('Save and Continue')])).toMatchObject({
      text: 'Save and Continue',
      isFinal: false,
    });
    expect(pickAdvance([button('Next')])).toMatchObject({ isFinal: false });
    expect(pickAdvance([button('Review')])).toMatchObject({ isFinal: false });
    expect(pickAdvance([button('Submit application', { submit: true })])).toMatchObject({
      text: 'Submit application',
      isFinal: true,
    });
    // Words that say submit win over words that say next.
    expect(pickAdvance([button('Continue and submit')])).toMatchObject({ isFinal: true });
    expect(pickAdvance([button('Review and submit')])).toMatchObject({ isFinal: true });
    // An unnamed submit button is final: Read never presses what it can't name.
    expect(pickAdvance([button('Go', { submit: true })])).toMatchObject({
      text: 'Go',
      isFinal: true,
    });
  });

  it('ignores shortcuts and widget buttons', () => {
    const picked = pickAdvance([
      button('Apply with LinkedIn'),
      button('Attach'),
      button('Upload File'),
      button('Toggle flyout'),
      button('Accept all'),
      button('Apply'),
    ]);
    expect(picked).toMatchObject({ text: 'Apply', isFinal: true });
    expect(pickAdvance([button('Attach'), button('Enter manually')])).toEqual({
      ref: null,
      text: null,
      isFinal: true,
    });
  });

  it('prefers the form\'s own last submit over a repeated "Apply" in the page header', () => {
    const picked = pickAdvance([
      button('Apply', { inRoot: false }),
      button('Submit application', { submit: true }),
    ]);
    expect(picked.text).toBe('Submit application');
  });
});

describe('the read-only guard', () => {
  it('lets GraphQL queries through and nothing that writes', () => {
    expect(
      isGraphqlQuery('{"operationName":"ApiJobPosting","query":"query ApiJobPosting { x }"}'),
    ).toBe(true);
    expect(isGraphqlQuery('[{"query":"{ a }"},{"query":"query B { b }"}]')).toBe(true);
    expect(
      isGraphqlQuery(
        '{"operationName":"ApiSetFormValue","query":"mutation ApiSetFormValue { x }"}',
      ),
    ).toBe(false);
    expect(isGraphqlQuery('[{"query":"{ a }"},{"query":"mutation M { m }"}]')).toBe(false);
    expect(isGraphqlQuery('first_name=Alex&email=a%40b.c')).toBe(false);
    expect(isGraphqlQuery(null)).toBe(false);
  });
});

describe('option matching', () => {
  it('matches exactly, by yes/no, and by a whole option inside the answer', () => {
    expect(matchOptionExact(['Yes', 'No'], 'no')).toBe('No');
    expect(matchOptionExact(['Yes', 'No'], 'Yes, EU citizen')).toBe('Yes');
    expect(matchOptionExact(['Greece +30', 'Germany +49'], 'Greece')).toBe('Greece +30');
    expect(matchOptionExact(['Greece', 'Cyprus', 'Germany'], 'Athens, Greece')).toBe('Greece');
  });

  it('leaves anything ambiguous to option_match', () => {
    expect(matchOptionExact(['Yes', 'No'], 'EU citizen, no sponsorship needed')).toBeNull();
    expect(
      matchOptionExact(
        ['Athens, Attica, Greece', 'Athens, Georgia, United States'],
        'Athens, Greece',
      ),
    ).toBeNull();
    expect(matchOptionExact(['Yes', 'No'], '')).toBeNull();
  });

  it('placeholders: decline for demographic questions, else the first real option', () => {
    expect(
      placeholderOption({
        options: ['Male', 'Female', 'Decline to self-identify'],
        meaning: 'eeo',
      }),
    ).toBe('Decline to self-identify');
    expect(placeholderOption({ options: ['Other', 'LinkedIn'], meaning: 'how_heard' })).toBe(
      'LinkedIn',
    );
    expect(placeholderOption({ options: [], meaning: null })).toBeNull();
  });
});

describe('standard profile values', () => {
  const profile = Object.fromEntries(STANDARD_KEYS.map((k) => [k, null])) as StandardProfile;
  profile.full_name = 'Roman Example Kudin';
  profile.location = 'Athens, Greece';
  profile.work_authorization = 'No';

  it('derives name parts and places, and answers sponsorship from work authorisation', () => {
    expect(standardValue('first_name', profile)).toBe('Roman');
    expect(standardValue('last_name', profile)).toBe('Example Kudin');
    expect(standardValue('city', profile)).toBe('Athens');
    expect(standardValue('country', profile)).toBe('Greece');
    expect(standardValue('visa_sponsorship', profile)).toBe('No');
    expect(standardValue('question', profile)).toBeNull();
  });

  it('validates what the CLI sets', () => {
    expect(parseProfileValue('email', ' me@example.com ')).toBe('me@example.com');
    expect(() => parseProfileValue('email', 'not-mail')).toThrow(/not an email/);
    expect(parseProfileValue('links.github', 'github.com/me')).toBe('https://github.com/me');
    expect(() => parseProfileValue('links.linkedin', 'https://example.com/me')).toThrow(/LinkedIn/);
    expect(parseProfileValue('work_authorization', '')).toBeNull();
    expect(() => parseProfileValue('base_cv_file', 'cv.pdf')).toThrow(/absolute/);
    const dir = mkdtempSync(join(tmpdir(), 'applyant-profile-'));
    try {
      const file = join(dir, 'cv.pdf');
      writeFileSync(file, '%PDF-1.4');
      expect(parseProfileValue('base_cv_file', file)).toBe(file);
      expect(() => parseProfileValue('base_cv_file', join(dir, 'missing.pdf'))).toThrow(/no file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseAriaLine', () => {
  it('reads role and accessible name from an ariaSnapshot line', () => {
    expect(parseAriaLine('- textbox "Email*"')).toEqual({ role: 'textbox', name: 'Email*' });
    expect(parseAriaLine('- combobox "Say \\"hi\\"": x\n  - option "a"')).toEqual({
      role: 'combobox',
      name: 'Say "hi"',
    });
    expect(parseAriaLine('- group:\n  - radio "Yes"')).toEqual({ role: 'group', name: '' });
    expect(parseAriaLine('')).toBeNull();
  });
});
