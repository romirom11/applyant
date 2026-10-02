// Preferences pre-filled from the imported CV (phase 16 onboarding, step 3). Read from the
// facts and projects the import drafted, from the profile and from what the CV's header read
// suggested (knowledge/cv-header.ts), with no model run of its own: the roles are the titles
// that reading suggests (or the ones the candidate held), titles give the seniority, the CV's
// languages and place give languages, country and city, the salary expectation the target. Each value
// is in SetPreference's form, with the lines it came from, so the candidate adjusts and confirms
// it; nothing here is stored. Keys the candidate already set are left out.
import { ne } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { facts, preferences, projects } from '../../db/schema.ts';
import type { Seniority } from '../../models/schemas/posting.ts';
import { getCvSuggestions } from '../knowledge/cv-header.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { CEFR_LEVELS, cleanRoles, MAX_ROLE_LENGTH, parseMoney } from '../scoring/prefs.ts';
import { listedPlace } from '../scoring/regions.ts';

export interface PreferenceSuggestion {
  key: string;
  value: string;
  reason: string;
  factIds: number[];
}

interface Line {
  text: string;
  factId: number | null;
  /** Titles and role facts weigh more than skills mentioned in passing. */
  title: boolean;
}

const SENIORITY_WORDS: Array<[RegExp, Seniority]> = [
  [/\b(head of|vp|director|cto)\b/i, 'head'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(lead|tech lead|team lead|led a team)\b/i, 'lead'],
  [/\b(senior|sr\.?)\b/i, 'senior'],
  [/\b(middle|mid-level|mid)\b/i, 'mid'],
  [/\b(junior|jr\.?)\b/i, 'junior'],
  [/\b(intern|internship)\b/i, 'intern'],
];
const SENIORITY_ORDER: Seniority[] = [
  'intern',
  'junior',
  'mid',
  'senior',
  'lead',
  'staff',
  'principal',
  'head',
];

const LANGUAGES: Record<string, string> = {
  english: 'en',
  german: 'de',
  deutsch: 'de',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  portuguese: 'pt',
  dutch: 'nl',
  polish: 'pl',
  ukrainian: 'uk',
  russian: 'ru',
  greek: 'el',
  czech: 'cs',
  romanian: 'ro',
  turkish: 'tr',
  swedish: 'sv',
};
const LEVEL_WORDS: Array<[RegExp, string]> = [
  [/\b(native|mother tongue|first language)\b/i, 'native'],
  [/\b(C2|proficient|bilingual)\b/i, 'C2'],
  [/\b(C1|fluent|advanced)\b/i, 'C1'],
  [/\b(B2|upper[\s-]intermediate|professional working)\b/i, 'B2'],
  [/\b(B1|intermediate|conversational)\b/i, 'B1'],
  [/\b(A2|elementary|pre-intermediate)\b/i, 'A2'],
  [/\b(A1|basic|beginner)\b/i, 'A1'],
];

/**
 * A title the candidate held, as a role to search for: without the employer or what it was
 * for ("Tech Lead for the agents platform at Acme"), and without the seniority, which is its
 * own preference ("Senior Backend Engineer").
 */
function heldTitle(text: string): string {
  return text
    .replace(/\s+(at|@|for|of|with|on|in)\s+.*$/i, '')
    .replace(/^(senior|sr\.?|junior|jr\.?|middle|mid(-level)?|staff|principal)\s+/i, '')
    .trim();
}

/** A few of the lines a suggestion rests on: each once, the shortest (the titles) first. */
function quote(lines: Line[]): string {
  const unique = [
    ...new Map(lines.map((l) => [l.text.trim().toLowerCase(), l.text.trim()])).values(),
  ];
  const shown = [...unique]
    .sort((a, b) => a.length - b.length)
    .slice(0, 3)
    .map((t) => `"${t.length > 60 ? `${t.slice(0, 57)}…` : t}"`);
  return `${shown.join(', ')}${unique.length > 3 ? ` and ${unique.length - 3} more` : ''}`;
}

function ids(lines: Line[]): number[] {
  return [...new Set(lines.map((l) => l.factId).filter((id): id is number => id !== null))];
}

export function preferencesDraft(conn: Conn): PreferenceSuggestion[] {
  const alreadySet = new Set(
    conn
      .select({ key: preferences.key })
      .from(preferences)
      .all()
      .map((r) => r.key),
  );
  const profile = getStandardProfile(conn);
  const cv = getCvSuggestions(conn);
  const factRows = conn
    .select({ id: facts.id, text: facts.text, kind: facts.kind })
    .from(facts)
    .where(ne(facts.status, 'rejected'))
    .all();
  const lines: Line[] = [
    ...(profile.current_title ? [{ text: profile.current_title, factId: null, title: true }] : []),
    ...conn
      .select({ role: projects.role })
      .from(projects)
      .all()
      .filter((p) => p.role)
      .map((p) => ({ text: p.role ?? '', factId: null, title: true })),
    ...factRows.map((f) => ({ text: f.text, factId: f.id, title: f.kind === 'role' })),
  ];
  const out: PreferenceSuggestion[] = [];

  // Roles: the titles the CV's own reading suggests, else the titles the candidate held.
  const titles = lines.filter((l) => l.title);
  if (!alreadySet.has('roles')) {
    const suggested = cleanRoles(cv?.roles ?? []).filter((r) => r.length <= MAX_ROLE_LENGTH);
    const held = cleanRoles(titles.map((l) => heldTitle(l.text)).filter((t) => t.length <= 40));
    const roles = (suggested.length ? suggested : held).slice(0, 6);
    if (roles.length) {
      out.push({
        key: 'roles',
        value: roles.join(', '),
        reason: suggested.length
          ? `From your CV: you worked as ${quote(titles.length ? titles : lines)}`
          : 'From your CV: the titles you held',
        factIds: ids(titles),
      });
    }
  }

  // Seniority: the highest level the titles show, and the one below it.
  const levels = new Map<Seniority, Line[]>();
  for (const l of titles) {
    const hit = SENIORITY_WORDS.find(([re]) => re.test(l.text));
    if (!hit) continue;
    levels.set(hit[1], [...(levels.get(hit[1]) ?? []), l]);
  }
  if (levels.size && !alreadySet.has('seniority')) {
    const top = [...levels.keys()].sort(
      (a, b) => SENIORITY_ORDER.indexOf(b) - SENIORITY_ORDER.indexOf(a),
    )[0] as Seniority;
    const i = SENIORITY_ORDER.indexOf(top);
    const pick = i >= 3 ? [SENIORITY_ORDER[i - 1], top] : [top];
    const used = levels.get(top) ?? [];
    out.push({
      key: 'seniority',
      value: pick.join(', '),
      reason: `Your most senior title: ${quote(used)}`,
      factIds: ids(used),
    });
  }

  // Where the candidate is based: the country and city the CV states, else the profile's
  // location line.
  const place = profile.location ? listedPlace(profile.location) : null;
  const country = cv?.country ?? place?.countries[0] ?? null;
  const from = profile.location ? `Your profile's location: "${profile.location}"` : 'From your CV';
  if (country && !alreadySet.has('based_in')) {
    out.push({ key: 'based_in', value: country, reason: from, factIds: [] });
  }
  const city =
    cv?.city ??
    (profile.location?.includes(',') ? (profile.location.split(',')[0]?.trim() ?? null) : null);
  if (city && !alreadySet.has('based_city')) {
    out.push({ key: 'based_city', value: city, reason: from, factIds: [] });
  }

  // Languages: "English (C1)", "German — native", "Greek: fluent".
  const langs = new Map<string, { level: string; line: Line }>();
  for (const f of factRows) {
    for (const [word, code] of Object.entries(LANGUAGES)) {
      const m = new RegExp(`\\b${word}\\b([^,;.]{0,40})`, 'i').exec(f.text);
      if (!m) continue;
      const level = LEVEL_WORDS.find(([re]) => re.test(m[1] ?? ''))?.[1];
      if (level && !langs.has(code))
        langs.set(code, { level, line: { text: f.text, factId: f.id, title: false } });
    }
  }
  // The CV's own reading names every language it lists, not only the ones in the table above.
  const read = (cv?.languages ?? []).filter((l) =>
    (CEFR_LEVELS as readonly string[]).includes(l.level),
  );
  if (read.length && !alreadySet.has('languages')) {
    const used = [...langs.values()].map((v) => v.line);
    out.push({
      key: 'languages',
      value: read.map((l) => `${l.code}:${l.level}`).join(', '),
      reason: used.length ? `From your CV: ${quote(used)}` : 'From your CV',
      factIds: ids(used),
    });
  } else if (langs.size && !alreadySet.has('languages')) {
    const used = [...langs.values()].map((v) => v.line);
    out.push({
      key: 'languages',
      value: [...langs.entries()].map(([code, v]) => `${code}:${v.level}`).join(', '),
      reason: `From your CV: ${quote(used)}`,
      factIds: ids(used),
    });
  }

  // Target salary: the profile's expectation, when it reads as an amount per month or year.
  if (profile.salary_expectation && !alreadySet.has('salary')) {
    try {
      const money = parseMoney(profile.salary_expectation);
      out.push({
        key: 'salary',
        value: `${money.amount} ${money.currency}/${money.period}`,
        reason: `Your profile's salary expectation: "${profile.salary_expectation}"`,
        factIds: [],
      });
    } catch {
      // Not an amount we can read; the candidate types it in the step.
    }
  }
  return out;
}
