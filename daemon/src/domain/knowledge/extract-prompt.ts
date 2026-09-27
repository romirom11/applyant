// The extractor's instructions for knowledge sources. Bump PROMPT_VERSION when the prompt
// changes meaningfully: it is part of the content hash, so every source re-extracts once.
import type { SourceKind } from '../../db/schema.ts';
import type { SourceMaterial } from './sources/material.ts';

export const PROMPT_VERSION = 'extract-source/2';
export const MAX_FACTS_PER_SOURCE = 120;

export const EXTRACTOR_SYSTEM = `You read one source about a job candidate (a CV, a repository digest, a web page or a document) and turn it into atomic facts with evidence. Applyant later writes job applications from these facts, and the candidate confirms each one, so a fact that overstates the source does real harm.

Rules for facts:
- One claim per fact, short and specific. Keep names, technologies, numbers, dates and scale exactly as the source states them. Never round, combine or infer numbers.
- Only what the source actually says. Do not generalise ("strong leadership"), guess motives, or add technologies that are not named.
- Facts about the candidate (kinds personal_contribution, role, skill, impact, education) are written without a subject, in the past tense for past work: "Built the call-analysis pipeline in Python", "Led a team of 4 engineers".
- Work done by other people, or by "the team" without the candidate's part being clear, is kind team_context and names who did it: "The team migrated billing to Kafka", "Another contributor wrote the iOS client".
- kind: personal_contribution = something the candidate personally built, designed, wrote or did; role = title, employer, position, period, responsibility; skill = a technology, language or method the candidate used; impact = a measured or stated result of the candidate's work; team_context = the project, the team, other people's work; education = degrees, courses, certificates; other = anything else worth keeping (languages spoken, awards, publications).
- Every fact has at least one evidence entry: a locator (rules below) and, where possible, a short verbatim quote from the source (at most 200 characters).
- Skip boilerplate: contact details, generic self-descriptions, reference lists.
- At most ${MAX_FACTS_PER_SOURCE} facts; prefer the most specific ones.

Projects: list each project, product or position the source describes, with the candidate's role, period and stack exactly as stated (null when not stated).`;

export interface PromptInput {
  kind: SourceKind;
  material: SourceMaterial;
  /** Set when the source belongs to one project. */
  project: { name: string; summary: string | null } | null;
  /** Names of the projects that already exist, for profile-level sources. */
  knownProjects: string[];
}

export function extractorPrompt(i: PromptInput): string {
  const scope = i.project
    ? `This source belongs to the candidate's project "${i.project.name}"${
        i.project.summary ? ` (${i.project.summary})` : ''
      }. Every fact is about this project: set each fact's "project" to "${i.project.name}". Describe this project once in "projects".`
    : `This source is about the candidate as a whole (for example a CV). Set each fact's "project" to the name of the project or position it belongs to, exactly as you list it in "projects", or null for facts that belong to no single project (general skills, education, languages).${
        i.knownProjects.length
          ? ` Projects the candidate already has (reuse these names when the source means the same project): ${i.knownProjects.map((n) => `"${n}"`).join(', ')}.`
          : ''
      }`;
  const code =
    i.kind === 'github'
      ? `\n\nThis is a code repository. The digest separates the candidate's commits from other contributors'. A fact about what the candidate built, did or used must cite the candidate's own commits (commit:<sha>) or pull requests (pr:#<n>) whose subjects show exactly that work: cite every commit a claim needs, and never cite a commit or PR for work it doesn't describe. Keep one piece of work per fact rather than joining several. Everything else in the repository, including pull requests the candidate opened but other contributors wrote, is team_context. Never describe other contributors' work as the candidate's. A separate check drops any claim its cited commits don't show.`
      : '';
  return `${scope}${code}

Evidence locators for this source: ${i.material.locatorRules}.

Source: ${i.material.label}
<source>
${i.material.text}
</source>`;
}
