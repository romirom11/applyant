// The candidate profile: key → JSON value.
//   lists     the identities that decide authorship (GitHub logins, commit emails, AI agents)
//   standard  the values application forms ask for (name, email, location, work authorisation,
//             …). Read dry-fills forms with them, so conditional fields show the branch the
//             candidate's real answer takes.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { profile } from '../../db/schema.ts';
import { defaultAgentIds, isAutomationBot } from './ai-agents.ts';

export const LIST_KEYS = ['github_logins', 'commit_emails', 'ai_agent_identities'] as const;
export type ProfileListKey = (typeof LIST_KEYS)[number];

/** Single-value fields that application forms ask for. */
export const STANDARD_KEYS = [
  'full_name',
  'email',
  'phone',
  'location',
  'work_authorization',
  'salary_expectation',
  'notice_period',
  'links.github',
  'links.website',
  'links.linkedin',
  'base_cv_file',
] as const;
export type StandardKey = (typeof STANDARD_KEYS)[number];
export type StandardProfile = Record<StandardKey, string | null>;

export const PROFILE_KEYS: readonly string[] = [...LIST_KEYS, ...STANDARD_KEYS];

export function isStandardKey(key: string): key is StandardKey {
  return (STANDARD_KEYS as readonly string[]).includes(key);
}

export class ProfileError extends Error {}

export interface Identities {
  /** GitHub logins, lowercase. */
  logins: string[];
  /** Commit author emails, lowercase. */
  emails: string[];
  /**
   * AI coding agents the candidate works through (emails and logins, lowercase): the
   * defaults plus `ai_agent_identities`. See ai-agents.ts for when their commits count.
   */
  agents: string[];
}

function list(conn: Conn, key: ProfileListKey): string[] {
  const row = conn.select().from(profile).where(eq(profile.key, key)).get();
  return Array.isArray(row?.value) ? (row.value as unknown[]).map(String) : [];
}

export function getIdentities(conn: Conn): Identities {
  return {
    logins: list(conn, 'github_logins').map((l) => l.toLowerCase()),
    emails: list(conn, 'commit_emails').map((e) => e.toLowerCase()),
    agents: [
      ...new Set(
        [...defaultAgentIds(), ...list(conn, 'ai_agent_identities')].map((a) => a.toLowerCase()),
      ),
    ],
  };
}

export function getStandardProfile(conn: Conn): StandardProfile {
  const all = getProfile(conn);
  const out = {} as StandardProfile;
  for (const key of STANDARD_KEYS) {
    const v = all[key];
    out[key] = typeof v === 'string' && v.trim() ? v : null;
  }
  return out;
}

export function getProfile(conn: Conn): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of conn.select().from(profile).all()) out[row.key] = row.value;
  return out;
}

function parseStandard(key: StandardKey, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  switch (key) {
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        throw new ProfileError(`"${v}" is not an email address`);
      return v;
    case 'links.github':
    case 'links.website':
    case 'links.linkedin': {
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      } catch {
        throw new ProfileError(`"${v}" is not a URL`);
      }
      if (key === 'links.github' && !/(^|\.)github\.com$/i.test(url.hostname))
        throw new ProfileError(`"${v}" is not a GitHub URL`);
      if (key === 'links.linkedin' && !/(^|\.)linkedin\.com$/i.test(url.hostname))
        throw new ProfileError(`"${v}" is not a LinkedIn URL`);
      return url.toString();
    }
    case 'base_cv_file':
      if (!isAbsolute(v)) throw new ProfileError('base_cv_file must be an absolute path');
      if (!existsSync(v) || !statSync(v).isFile()) throw new ProfileError(`no file at ${v}`);
      return v;
    default:
      return v;
  }
}

/**
 * Parses and validates a CLI value for `key`. List keys take comma-separated values; standard
 * keys one value (empty clears it, returned as null).
 */
export function parseProfileValue(key: string, raw: string): unknown {
  if (isStandardKey(key)) return parseStandard(key, raw);
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
    if (key === 'ai_agent_identities') {
      if (!/^[^\s@]+@[^\s@]+$/.test(v) && !/^[a-z\d](?:[a-z\d-]{0,38})(\[bot\])?$/i.test(v)) {
        throw new ProfileError(`"${v}" is neither a commit email nor a GitHub login`);
      }
      if (isAutomationBot(v)) {
        throw new ProfileError(
          `"${v}" is an automation bot, not a coding agent; its commits are never yours`,
        );
      }
    }
  }
  return values;
}

/** Stores a value; null deletes the key. */
export function setProfileValue(conn: Conn, key: string, value: unknown, now: Date): void {
  if (value === null) {
    conn.delete(profile).where(eq(profile.key, key)).run();
    return;
  }
  conn
    .insert(profile)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: profile.key, set: { value, updatedAt: now } })
    .run();
}
