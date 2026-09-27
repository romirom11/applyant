# applyant

A personal, evidence-backed job-search harness. `applyantd` (TypeScript on Node) owns all
logic and state; the `applyant` CLI and, later, the macOS app are thin clients of its
Connect API (`proto/applyant/v1/applyant.proto`).

## Layout

- `proto/` — the only client ↔ daemon contract; `buf generate` writes `daemon/src/gen`
- `daemon/` — `applyantd` and the `applyant` CLI (one pnpm package, Node ≥ 24 runs the `.ts` sources directly)

## Development (Linux)

```sh
pnpm -C daemon install
pnpm -C daemon exec playwright install --only-shell --with-deps chromium
buf lint && buf generate          # after changing the .proto
pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test
```

Run the daemon and talk to it:

```sh
pnpm -C daemon start                          # applyantd; state in $APPLYANT_HOME (default ~/.local/share/applyant)
pnpm -C daemon cli jobs add <posting-url>
pnpm -C daemon cli jobs list
pnpm -C daemon cli runs show --follow
printf %s "$KEY" | pnpm -C daemon cli secrets set jev
```

Candidate knowledge (facts are extracted by the `claude` CLI signed in on this machine;
set `APPLYANT_CLAUDE_PATH` if it isn't on the daemon's `PATH`):

```sh
pnpm -C daemon cli candidate profile set github_logins <login>        # decides which commits are yours
pnpm -C daemon cli candidate profile set commit_emails you@example.com
# Commits by your AI coding agents (Claude Code, Codex, Cursor, Copilot built in) count as yours
# in repos you own and in PRs you opened or merged; add other agents' emails or logins:
pnpm -C daemon cli candidate profile set ai_agent_identities aider@example.dev
pnpm -C daemon cli candidate source add profile file ~/cv.pdf         # a CV drafts projects + facts
pnpm -C daemon cli candidate project add Solovei
pnpm -C daemon cli candidate source add solovei github https://github.com/<owner>/<repo>
pnpm -C daemon cli candidate fact list solovei                        # every fact with its evidence
pnpm -C daemon cli candidate fact confirm <id…>                       # or: fact edit <id> "<text>" · fact reject <id…>
pnpm -C daemon cli candidate sync [project | profile | github] [--force]
```

Live tests call the real agent CLIs (and spend subscription quota), so they only run on request:

```sh
APPLYANT_LIVE=1 pnpm -C daemon test:live -t extractor
```

Schema changes: edit `daemon/src/db/schema.ts`, then `pnpm -C daemon db:generate --name <what>`
(never `drizzle-kit push`).
