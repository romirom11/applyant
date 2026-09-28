import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '../src/browser/form-types.ts';
import { profileText } from '../src/domain/applications/standard-fields.ts';

const field = (label: string) => ({ label }) as FieldSpec;
const profile = { location: 'Athens, Greece' } as Parameters<typeof profileText>[2];

describe('location from the profile', () => {
  it('gives the part a label asks for, or the whole location', () => {
    expect(profileText('location', field('Country'), profile).value).toBe('Greece');
    expect(profileText('location', field('City you live in'), profile).value).toBe('Athens');
    // Found on a real-looking form: both parts asked for in one field.
    expect(profileText('location', field('Location (city, country)'), profile).value).toBe(
      'Athens, Greece',
    );
    expect(profileText('location', field('Where are you based?'), profile).value).toBe(
      'Athens, Greece',
    );
  });
});
