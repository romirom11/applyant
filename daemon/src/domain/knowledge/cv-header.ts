// A CV's header, read once: the candidate's name and contacts go into the profile (only into
// fields that are still empty: what the candidate typed is never replaced), and the rest (city,
// country, languages, the job titles they'd search for) is kept as the CV's suggestions for the
// first preferences (setup/prefs-draft.ts). One extractor run per CV text: the same text is
// never read twice, a changed CV is read again.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { profile } from '../../db/schema.ts';
import type { AgentRunner } from '../../models/agent-runner.ts';
import { type CvHeader, cvHeaderSchema } from '../../models/schemas/cv-header.ts';
import type { Tx } from '../../queue/types.ts';
import {
  getIdentities,
  getStandardProfile,
  ProfileError,
  parseProfileValue,
  type StandardKey,
  setProfileValue,
} from './profile.ts';

/** Where the CV's suggestions for preferences are kept (a profile row, not a candidate's field). */
export const CV_SUGGESTIONS_KEY = 'cv_suggestions';

export interface CvSuggestions {
  city: string | null;
  country: string | null;
  languages: Array<{ code: string; level: string }>;
  roles: string[];
  /** Hashes of the texts already read (a CV, another CV, an assistant's notes): each once. */
  textHashes: string[];
}

/** The profile fields a CV header can fill. */
const FILLS: ReadonlyArray<[StandardKey, keyof CvHeader]> = [
  ['full_name', 'fullName'],
  ['email', 'email'],
  ['phone', 'phone'],
  ['location', 'location'],
  ['links.github', 'github'],
  ['links.linkedin', 'linkedin'],
  ['links.website', 'website'],
  ['current_title', 'currentTitle'],
  ['current_company', 'currentCompany'],
];

const CV_HEADER_SYSTEM = `You read a job candidate's CV (or another document about them, such as notes an AI assistant wrote from what it remembers) and return who they are and what they would look for next. Copy names, addresses, numbers and links exactly as the document writes them; return null for anything the CV doesn't state, and never guess a contact detail. targetRoles are your reading of the whole CV: the job titles this person would type into a job board.`;

/** How much of the CV the header run reads: contact details sit at the top, titles below. */
const HEADER_CHARS = 24_000;

export function getCvSuggestions(conn: Conn): CvSuggestions | null {
  const row = conn.select().from(profile).where(eq(profile.key, CV_SUGGESTIONS_KEY)).get();
  const v = row?.value as Partial<CvSuggestions> | undefined;
  if (!v || typeof v !== 'object') return null;
  return {
    city: typeof v.city === 'string' ? v.city : null,
    country: typeof v.country === 'string' ? v.country : null,
    languages: Array.isArray(v.languages) ? v.languages : [],
    roles: Array.isArray(v.roles) ? v.roles.map(String) : [],
    textHashes: Array.isArray(v.textHashes) ? v.textHashes.map(String) : [],
  };
}

export function cvTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Whether this text's header is still to be read (a read that failed for good counts as
 * read).
 */
export function wantsCvHeader(conn: Conn, text: string): boolean {
  return !getCvSuggestions(conn)?.textHashes.includes(cvTextHash(text));
}

const NOTHING: CvSuggestions = {
  city: null,
  country: null,
  languages: [],
  roles: [],
  textHashes: [],
};

function withText(kept: CvSuggestions | null, text: string): CvSuggestions {
  const base = kept ?? NOTHING;
  return { ...base, textHashes: [...new Set([...base.textHashes, cvTextHash(text)])] };
}

/**
 * The header couldn't be read (not a limit, which passes): remembered for this text, so an
 * unchanged CV isn't sent to the model again at every sync.
 */
export function markCvHeaderUnread(tx: Tx, text: string): void {
  setProfileValue(tx.db, CV_SUGGESTIONS_KEY, withText(getCvSuggestions(tx.db), text), tx.now);
}

export type CvHeaderRead =
  | { kind: 'ok'; header: CvHeader }
  /** `later`: a subscription limit, so the next sync tries again. */
  | { kind: 'skipped'; reason: string; later: boolean };

/** One extractor run over the CV's text. A failure or a limit is never fatal: the facts stay. */
export async function readCvHeader(
  models: AgentRunner,
  text: string,
  o: { taskId: number; signal: AbortSignal; progress?: (message: string) => void },
): Promise<CvHeaderRead> {
  const res = await models.run('extractor', {
    schema: cvHeaderSchema,
    system: CV_HEADER_SYSTEM,
    prompt: `<cv>\n${text.slice(0, HEADER_CHARS)}\n</cv>`,
    taskId: o.taskId,
    signal: o.signal,
    ...(o.progress ? { progress: o.progress } : {}),
  });
  if (res.kind === 'ok') return { kind: 'ok', header: res.output };
  return res.kind === 'limit'
    ? { kind: 'skipped', reason: `${res.provider} limit`, later: true }
    : { kind: 'skipped', reason: res.reason, later: false };
}

function clean(value: string | null): string | null {
  const v = value?.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

/**
 * Stores what the header gave: empty profile fields are filled, the GitHub login is taken from
 * the profile link when none is saved, and the suggestions gain what they lacked: what an
 * earlier text gave (the CV, read first) stays, a later one (another document, an assistant's
 * notes) only adds. Returns the names of the profile fields it filled.
 */
export function applyCvHeader(tx: Tx, header: CvHeader, text: string): string[] {
  const current = getStandardProfile(tx.db);
  const filled: string[] = [];
  for (const [key, field] of FILLS) {
    const value = clean(header[field] as string | null);
    if (current[key] || !value) continue;
    try {
      const parsed = parseProfileValue(key, value);
      if (parsed === null) continue;
      setProfileValue(tx.db, key, parsed, tx.now);
      filled.push(key);
    } catch (err) {
      // Not an email, not a GitHub URL…: the CV's value is left out rather than stored wrong.
      if (!(err instanceof ProfileError)) throw err;
    }
  }
  const login = /github\.com\/([A-Za-z\d][A-Za-z\d-]{0,38})\/?$/i.exec(
    clean(header.github) ?? '',
  )?.[1];
  if (login && getIdentities(tx.db).logins.length === 0) {
    setProfileValue(tx.db, 'github_logins', [login], tx.now);
    filled.push('github_logins');
  }
  const country = clean(header.country)?.toUpperCase() ?? null;
  const had = withText(getCvSuggestions(tx.db), text);
  const languages = header.languages
    .map((l) => ({ code: l.code.trim().toLowerCase(), level: l.level as string }))
    .filter((l) => /^[a-z]{2}$/.test(l.code));
  const roles = header.targetRoles.map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const suggestions: CvSuggestions = {
    city: had.city ?? clean(header.city),
    country: had.country ?? (country && /^[A-Z]{2}$/.test(country) ? country : null),
    languages: [
      ...had.languages,
      ...languages.filter((l) => !had.languages.some((h) => h.code === l.code)),
    ],
    roles: [
      ...had.roles,
      ...roles.filter((r) => !had.roles.some((h) => h.toLowerCase() === r.toLowerCase())),
    ].slice(0, 8),
    textHashes: had.textHashes,
  };
  setProfileValue(tx.db, CV_SUGGESTIONS_KEY, suggestions, tx.now);
  return filled;
}
