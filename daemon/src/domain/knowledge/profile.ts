// The candidate profile: key → JSON value. For now only the GitHub identities that decide
// authorship; phase 4 adds the standard form fields (name, email, location, ...).
import { eq } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { profile } from '../../db/schema.ts';

export const LIST_KEYS = ['github_logins', 'commit_emails'] as const;
export type ProfileListKey = (typeof LIST_KEYS)[number];
export const PROFILE_KEYS: readonly string[] = [...LIST_KEYS];

export class ProfileError extends Error {}

export interface Identities {
  /** GitHub logins, lowercase. */
  logins: string[];
  /** Commit author emails, lowercase. */
  emails: string[];
}

function list(conn: Conn, key: ProfileListKey): string[] {
  const row = conn.select().from(profile).where(eq(profile.key, key)).get();
  return Array.isArray(row?.value) ? (row.value as unknown[]).map(String) : [];
}

export function getIdentities(conn: Conn): Identities {
  return {
    logins: list(conn, 'github_logins').map((l) => l.toLowerCase()),
    emails: list(conn, 'commit_emails').map((e) => e.toLowerCase()),
  };
}

export function getProfile(conn: Conn): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of conn.select().from(profile).all()) out[row.key] = row.value;
  return out;
}

/** Parses and validates a CLI value for `key`. List keys take comma-separated values. */
export function parseProfileValue(key: string, raw: string): unknown {
  if (!(LIST_KEYS as readonly string[]).includes(key)) {
    throw new ProfileError(`unknown profile key "${key}" (known: ${PROFILE_KEYS.join(', ')})`);
  }
  const values = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
  for (const v of values) {
    if (key === 'github_logins' && !/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(v)) {
      throw new ProfileError(`"${v}" is not a GitHub login`);
    }
    if (key === 'commit_emails' && !/^[^\s@]+@[^\s@]+$/.test(v)) {
      throw new ProfileError(`"${v}" is not an email address`);
    }
  }
  return values;
}

export function setProfileValue(conn: Conn, key: string, value: unknown, now: Date): void {
  conn
    .insert(profile)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: profile.key, set: { value, updatedAt: now } })
    .run();
}
