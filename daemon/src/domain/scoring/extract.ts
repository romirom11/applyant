// The extractor, on postings: the posting text → requirements (must / nice), seniority,
// where and how the work happens, salary, languages and employment type. Run once per
// posting text; the result is cached on the posting under `extractionKey`.
// Bump POSTING_PROMPT_VERSION when the prompt or schema changes meaningfully.
import { createHash } from 'node:crypto';
import type { PostingExtraction } from '../../models/schemas/posting.ts';

export const POSTING_PROMPT_VERSION = 'extract-posting/2';
/** Postings longer than this are cut (a posting is a few thousand characters). */
export const MAX_POSTING_CHARS = 30_000;
export const MAX_REQUIREMENTS = 30;

export const POSTING_EXTRACTOR_SYSTEM = `You read one job posting and extract the facts a candidate's fit is judged on. A program computes the fit score from your output, so extract faithfully and never judge fit yourself.

Requirements:
- One entry per distinct requirement the posting states: skills, technologies, experience, domain knowledge, education, responsibilities the candidate must already be able to do. Keep the posting's own wording and numbers ("5+ years of Python in production"); split lists into separate requirements when they are separate skills ("Python or Go" stays one).
- must: every item of a requirements list ("Requirements", "What we're looking for", "You have", "Qualifications", "What you bring") is must = true, even when the list is introduced softly ("ideally you bring", "we'd love"). must = false only for items the posting explicitly marks or lists separately as nice-to-have, bonus, preferred or a plus. If the posting has no separate nice-to-have list, every requirement is must = true.
- kind: "skill" for experience, knowledge or ability; "condition" for availability, willingness or circumstance that experience can't show (willing to travel, relocate, work in a time zone, be on call, a work permit, a start date).
- Leave out perks, company descriptions, process steps, statements of what is not required ("no degree required"), and conditions you put in other fields (location, remote, salary, language, employment type).
- At most ${MAX_REQUIREMENTS} requirements; keep the most specific.

Other fields:
- seniority: the level the posting hires for; "unknown" if it doesn't say (don't guess from years alone unless the title or text states a level).
- roleFamilies: the kinds of work, most important first. "founding" for founding-engineer / first-engineer roles.
- workplace: remote, hybrid, onsite, or unknown when not stated. A workplace label in the page header ("Hybrid", "Remote", "On-site", shown next to the title and location) is the posting's own classification and wins over body text. Benefits and perks never define the workplace: "work from anywhere a few weeks a year", a remote-work stipend or a mobility / nomad programme don't make a hybrid or on-site role remote. Some boards mark hybrid roles as jobLocationType TELECOMMUTE in structured data, so that alone doesn't mean remote when an office location is given. remoteRegions / remoteCountries: only where the posting states who may work remotely ("Remote (EU)", "US only", "anywhere"); leave empty when it doesn't say. offices: stated office or on-site locations, country as ISO 3166-1 alpha-2.
- salary: only a stated salary or rate, with numbers exactly as written (convert "80k" to 80000). period: hour, day, month or year as stated. basis: "gross" when the posting says gross, or states an annual base salary / compensation range (gross by convention); "net" only when it says net; null otherwise. currency as ISO 4217. null when no salary is stated.
- languages: human languages the posting asks for (ISO 639-1), with level when stated. postingLanguage: the language the posting is written in.
- employment: the stated type, null if not stated. outstaffing: true only when the posting is from an outstaffing / outsourcing / staffing agency placing the hire with a client.
- title and company as the posting writes them; company is the employer, not the job board.`;

export function extractionKey(text: string): string {
  return createHash('sha256')
    .update(POSTING_PROMPT_VERSION)
    .update('\0')
    .update(text)
    .digest('hex');
}

export function postingPrompt(p: {
  url: string;
  title: string | null;
  company: string | null;
  text: string;
}): string {
  const text =
    p.text.length > MAX_POSTING_CHARS ? `${p.text.slice(0, MAX_POSTING_CHARS)}\n[…cut]` : p.text;
  return `Posting URL: ${p.url}${p.title ? `\nPage title: ${p.title}` : ''}${p.company ? `\nCompany (from the page): ${p.company}` : ''}

<posting>
${text}
</posting>`;
}

export function validatePostingExtraction(out: PostingExtraction): string | null {
  const empty = out.requirements.findIndex((r) => !r.text.trim());
  return empty === -1 ? null : `requirement ${empty} has no text`;
}

const iso2 = (s: string | null): string | null => {
  const c = s?.trim().toUpperCase() ?? '';
  // Common non-ISO spellings.
  const fixed = c === 'UK' ? 'GB' : c;
  return /^[A-Z]{2}$/.test(fixed) ? fixed : null;
};

/**
 * Cleans what the schema can't enforce: codes, blanks, duplicates, counts. A list with no
 * must-have at all had no must/nice split, so every skill in it is a must-have.
 */
export function normaliseExtraction(out: PostingExtraction): PostingExtraction {
  const seen = new Set<string>();
  const noSplit = out.requirements.length > 0 && out.requirements.every((r) => !r.must);
  const requirements = out.requirements
    .map((r) => ({
      text: r.text.replace(/\s+/g, ' ').trim().slice(0, 300),
      must: r.must || noSplit,
      kind: r.kind,
    }))
    .filter((r) => {
      const key = r.text.toLowerCase();
      if (!r.text || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_REQUIREMENTS);
  const salary = out.salary
    ? {
        ...out.salary,
        currency: out.salary.currency?.trim().toUpperCase().slice(0, 3) || null,
        min: out.salary.min !== null && out.salary.min > 0 ? out.salary.min : null,
        max: out.salary.max !== null && out.salary.max > 0 ? out.salary.max : null,
      }
    : null;
  return {
    ...out,
    title: out.title?.trim() || null,
    company: out.company?.trim() || null,
    summary: out.summary.trim(),
    roleFamilies: [...new Set(out.roleFamilies)],
    requirements,
    remoteRegions: [...new Set(out.remoteRegions)],
    remoteCountries: [...new Set(out.remoteCountries.map(iso2).filter((c): c is string => !!c))],
    offices: out.offices
      .map((o) => ({ city: o.city?.trim() || null, country: iso2(o.country) }))
      .filter((o) => o.city || o.country),
    salary,
    languages: out.languages
      .map((l) => ({ ...l, language: l.language.trim().toLowerCase().slice(0, 2) }))
      .filter((l) => /^[a-z]{2}$/.test(l.language)),
    postingLanguage: out.postingLanguage?.trim().toLowerCase().slice(0, 2) || null,
  };
}
