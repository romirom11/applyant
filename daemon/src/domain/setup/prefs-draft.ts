// Preferences pre-filled from the imported CV (phase 16 onboarding, step 3). Read from the
// facts and projects the import drafted and from the profile, deterministically (no model run):
// titles give role families and seniority, language lines give languages, the profile's
// location gives where the candidate is based, its salary expectation the target. Each value
// is in SetPreference's form, with the lines it came from, so the candidate adjusts and confirms
// it; nothing here is stored. Keys the candidate already set are left out.
import { ne } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { facts, preferences, projects } from '../../db/schema.ts';
import type { RoleFamily, Seniority } from '../../models/schemas/posting.ts';
import { getStandardProfile } from '../knowledge/profile.ts';
import { parseMoney } from '../scoring/prefs.ts';
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

const ROLE_WORDS: Array<[RegExp, RoleFamily]> = [
  [/\b(machine learning|ml|ai|llm|deep learning|nlp|computer vision|genai|agentic)\b/i, 'ai_ml'],
  [/\b(full[\s-]?stack)\b/i, 'fullstack'],
  [/\b(back[\s-]?end|server[\s-]side|api engineer)\b/i, 'backend'],
  [/\b(front[\s-]?end|ui engineer|react developer)\b/i, 'frontend'],
  [/\b(data engineer|data scientist|analytics engineer|data platform)\b/i, 'data'],
  [/\b(devops|sre|site reliability|platform engineer|infrastructure)\b/i, 'platform'],
  [/\b(ios|android|mobile)\b/i, 'mobile'],
  [/\b(security|appsec|pentest)/i, 'security'],
  [/\b(founding engineer|co-?founder|founder|cto)\b/i, 'founding'],
  [
    /\b(engineering manager|head of engineering|vp of engineering|director of engineering)\b/i,
    'management',
  ],
  [/\b(research (engineer|scientist)|researcher)\b/i, 'research'],
];

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

function quote(lines: Line[]): string {
  const shown = lines
    .slice(0, 3)
    .map((l) => `"${l.text.length > 80 ? `${l.text.slice(0, 77)}…` : l.text}"`);
  return `${shown.join(', ')}${lines.length > 3 ? ` and ${lines.length - 3} more` : ''}`;
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

  // Role families: from titles and role facts; a family needs a title, or two other lines.
  const titles = lines.filter((l) => l.title);
  const roleHits = new Map<RoleFamily, Line[]>();
  for (const l of lines) {
    for (const [re, family] of ROLE_WORDS) {
      if (!re.test(l.text)) continue;
      const hit = roleHits.get(family) ?? [];
      hit.push(l);
      roleHits.set(family, hit);
    }
  }
  const roles = [...roleHits.entries()]
    .filter(([, ls]) => ls.some((l) => l.title) || ls.length >= 2)
    .sort(
      (a, b) =>
        b[1].filter((l) => l.title).length - a[1].filter((l) => l.title).length ||
        b[1].length - a[1].length,
    )
    .slice(0, 4);
  if (roles.length && !alreadySet.has('roles')) {
    const used = roles.flatMap(([, ls]) => ls);
    out.push({
      key: 'roles',
      value: roles.map(([f]) => f).join(', '),
      reason: `From your CV: ${quote(used)}`,
      factIds: ids(used),
    });
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

  // Where the candidate is based: the profile's location.
  if (profile.location && !alreadySet.has('based_in')) {
    const country = listedPlace(profile.location).countries[0];
    if (country) {
      out.push({
        key: 'based_in',
        value: country,
        reason: `Your profile's location: "${profile.location}"`,
        factIds: [],
      });
    }
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
  if (langs.size && !alreadySet.has('languages')) {
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
