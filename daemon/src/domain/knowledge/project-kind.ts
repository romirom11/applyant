// A project is either a position (a job at an employer, a freelance engagement: it has a title
// and a stretch of time) or a project (a product, a side project, open source: something the
// candidate built). A CV shows them apart: positions as Experience, newest first, projects on
// their own. The extractor says which; for projects made before it did, and when it didn't
// say, the name and the role decide, and the candidate can always correct it.
import type { ProjectRow } from '../../db/schema.ts';

export const PROJECT_KINDS = ['position', 'project'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

const EMPLOYER =
  /\b(at|@)\s+\S|\b(llc|gmbh|inc|ltd|plc|pjsc|jsc|ooo|tov|s\.?a\.?|b\.?v\.?|ag|kg|corp|company|agency|studio|bank)\b|freelance|self-employed|contractor/i;
const TITLE =
  /\b(engineer|developer|lead|head|manager|director|administrator|architect|consultant|cto|ceo|cfo|founder|intern|analyst|designer|specialist|officer)\b/i;

/** The stored kind, or the best guess from the name, role and period. */
export function projectKind(
  p: Pick<ProjectRow, 'name' | 'role' | 'period'> & { kind?: ProjectKind | null },
): ProjectKind {
  if (p.kind) return p.kind;
  if (EMPLOYER.test(p.name)) return 'position';
  // A role that is a job title ("Head of IT", "Full Stack Web Developer") on a dated stretch.
  if (p.role && TITLE.test(p.role) && p.period && /\d{4}/.test(p.period)) {
    // "Founder, built the entire product" on a product's name is still the product.
    return /built|builder|creator|author|own|side|founder/i.test(p.role) && !EMPLOYER.test(p.role)
      ? 'project'
      : 'position';
  }
  return 'project';
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Where a period ends, for newest-first order: "Jul 2025 – May 2026" → May 2026; "present",
 * "current" or "now" → now; no year at all → null (it goes last).
 */
export function periodEnd(period: string | null, now = new Date()): number | null {
  if (!period) return null;
  const parts = period.split(/\s*(?:–|—|-|\.\.|to)\s*/i);
  const last = parts.at(-1) ?? '';
  if (/present|current|now|today|active/i.test(last) || /present|current|active/i.test(period)) {
    return now.getTime();
  }
  const year = /(\d{4})/.exec(last)?.[1] ?? [...period.matchAll(/(\d{4})/g)].at(-1)?.[1];
  if (!year) return null;
  const month = /([a-z]{3})[a-z]*\.?\s*\d{4}/i.exec(last)?.[1]?.toLowerCase();
  return Date.UTC(Number(year), month && month in MONTHS ? (MONTHS[month] ?? 11) : 11, 1);
}
