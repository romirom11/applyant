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

Scoring: a verified posting keeps its text and gets an explained 0–100 score. The `extractor`
reads its requirements, salary, location and so on once; the `matcher` judges each requirement
against facts found by hybrid retrieval (FTS5 + EmbeddingGemma vectors); the number itself comes
from a pure function over your preferences, so changing them re-scores instantly, with no model
call. The embedding model (~300 MB) is downloaded into `$APPLYANT_HOME/models` on first use
(`APPLYANT_MODELS_DIR` overrides; `APPLYANT_EMBEDDER=hash` is an offline keyword-only stand-in).

```sh
pnpm -C daemon cli candidate prefs set roles ai_ml,backend,founding    # see `candidate prefs set --help`
pnpm -C daemon cli candidate prefs set seniority senior,staff,lead
pnpm -C daemon cli candidate prefs set based_in GR                     # where you work from
pnpm -C daemon cli candidate prefs set locations GR,CY                 # on-site / hybrid is fine here
pnpm -C daemon cli candidate prefs set remote required                 # required | preferred | any
pnpm -C daemon cli candidate prefs set salary "3000 EUR/month"         # target (gross)
pnpm -C daemon cli candidate prefs set salary_floor "2000 EUR/month"   # optional hard floor
pnpm -C daemon cli candidate prefs set languages en:C1,el:native
pnpm -C daemon cli candidate prefs set employment full_time,contract
pnpm -C daemon cli candidate prefs dealbreaker add outstaffing         # only you create dealbreakers
pnpm -C daemon cli candidate prefs weight salary 15                    # · reset-weights · prefs show
pnpm -C daemon cli jobs list --by-score
pnpm -C daemon cli jobs show <id>                                      # breakdown and ✓/~/✗ per requirement
pnpm -C daemon cli jobs skip <id> --reason "salary too low"            # nudges weights, within bounds
pnpm -C daemon cli jobs interested <id>
pnpm -C daemon cli jobs score [id…]                                    # re-run; cached results are reused
```

Live tests call the real agent CLIs (and spend subscription quota), so they only run on request:

```sh
APPLYANT_LIVE=1 pnpm -C daemon test:live -t extractor
APPLYANT_LIVE=1 pnpm -C daemon test:live -t matcher    # also downloads EmbeddingGemma unless APPLYANT_MODELS_DIR has it
```

Schema changes: edit `daemon/src/db/schema.ts`, then `pnpm -C daemon db:generate --name <what>`
(never `drizzle-kit push`). Virtual tables (`facts_fts`, `facts_vec`) and their triggers live in
custom migrations (`pnpm -C daemon exec drizzle-kit generate --custom --name <what>`).
