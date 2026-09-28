// AI coding agents the candidate works through. Their commits are the candidate's own work
// (owner decision, phase 2) when they are in a repository the candidate owns, or in a PR the
// candidate opened or merged. Anywhere else they stay other contributors' work, and so do
// automation bots, which are never agents.
//
// Identities are commit author emails and GitHub logins, as GitHub shows them (checked
// against public commits, 2026-09):
//   Claude Code        Claude <noreply@anthropic.com>, login "claude"
//   Cursor agent       Cursor Agent <cursoragent@cursor.com>, login "cursoragent"
//   Copilot agent      copilot-swe-agent[bot] <198982749+Copilot@users.noreply.github.com>,
//                      login "Copilot"
//   Codex              Codex <codex@openai.com>, login "codex" (Codex cloud), and the
//                      connector app chatgpt-codex-connector[bot]
//                      <199175422+chatgpt-codex-connector[bot]@users.noreply.github.com>.
//                      Local Codex CLI commits use the user's own git identity.
// More can be added with `applyant candidate profile set ai_agent_identities <email|login>,…`.

export const DEFAULT_AI_AGENTS: ReadonlyArray<{ agent: string; ids: string[] }> = [
  { agent: 'Claude Code', ids: ['noreply@anthropic.com', 'claude', 'claude[bot]'] },
  { agent: 'Cursor', ids: ['cursoragent@cursor.com', 'cursoragent', 'cursor[bot]'] },
  {
    agent: 'GitHub Copilot coding agent',
    ids: ['198982749+copilot@users.noreply.github.com', 'copilot', 'copilot-swe-agent[bot]'],
  },
  {
    agent: 'OpenAI Codex',
    ids: [
      'codex@openai.com',
      'codex',
      '199175422+chatgpt-codex-connector[bot]@users.noreply.github.com',
      'chatgpt-codex-connector[bot]',
    ],
  },
];

/** Automation that is never the candidate's work, even if someone lists it as an agent. */
const NEVER =
  /^(?:\d+\+)?(github-actions|dependabot|renovate|dependabot-preview|mergify|codecov|pre-commit-ci)(\[bot\])?(@users\.noreply\.github\.com)?$/i;

export function isAutomationBot(id: string): boolean {
  return NEVER.test(id.trim());
}

export function defaultAgentIds(): string[] {
  return DEFAULT_AI_AGENTS.flatMap((a) => a.ids);
}

/** GitHub no-reply emails carry the login: `<id>+<login>@users.noreply.github.com`. */
export function noreplyLogin(email: string): string | null {
  const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

/** Matches commit authors against agent identities (emails and logins, lowercase). */
export class AgentMatcher {
  private readonly ids: Set<string>;

  constructor(ids: Iterable<string>) {
    this.ids = new Set(
      [...ids].map((i) => i.trim().toLowerCase()).filter((i) => i && !isAutomationBot(i)),
    );
  }

  matches(email: string, login: string | null = null): boolean {
    const e = email.trim().toLowerCase();
    if (isAutomationBot(e) || (login && isAutomationBot(login))) return false;
    if (e && this.ids.has(e)) return true;
    if (login && this.ids.has(login.toLowerCase())) return true;
    const fromEmail = noreplyLogin(e);
    return !!fromEmail && this.ids.has(fromEmail);
  }
}
