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
pnpm -C daemon exec playwright install --only-shell --with-deps chromium   # background reading
# Delivery (phase 6) submits through the installed Google Chrome, headed. On a headless box the
# window runs under xvfb (installed by --with-deps above); without a display the one test that
# needs a real window skips.
buf lint && buf generate          # after changing the .proto
pnpm -C daemon typecheck && pnpm -C daemon lint && xvfb-run -a pnpm -C daemon test
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

Application forms: after verification, `read_form` opens the posting's apply target in a
throwaway headless context and reads the real form: every step, field, required flag, option
list and conditional field (with the answer that reveals it). It dry-fills standard fields with
your profile values, so conditional questions show the branch your real answer takes, fills
questions with placeholders, tries each option of small choice fields, and presses "Next"-like
buttons to reach later steps. It never presses a submit button, never uploads your CV, and
blocks every request that could send data (autosaves, uploads, draft saves, submissions).
What each field asks for and which option matches your answer are Jev decisions
(`applyant secrets set jev`), with `claude:haiku` for anything Jev is unsure of or when it's off;
Jev also double-checks that a verified page reads as an open posting.

```sh
pnpm -C daemon cli candidate profile set full_name Alex Example         # the values forms ask for:
pnpm -C daemon cli candidate profile set email alex@example.com         #   email · phone · location
pnpm -C daemon cli candidate profile set location "Athens, Greece"      #   work_authorization · salary_expectation
pnpm -C daemon cli candidate profile set work_authorization "EU citizen, no sponsorship needed"
pnpm -C daemon cli candidate profile set base_cv_file ~/cv.pdf          #   notice_period · links.github|website|linkedin
pnpm -C daemon cli jobs show <id> --form                               # steps, fields, options, conditional fields
pnpm -C daemon cli jobs read-form [id…]                                # read again (default: every posting never read)
```

Applications: a posting that scores at or above your threshold (`candidate prefs set threshold`,
default 80) with no dealbreaker, or that you mark `interested`, gets an application prepared for
its real form. Standard fields come from your profile, which is only a default: nothing about
you is built in, a value your profile lacks is never guessed (the application waits for you
instead), and every value can be set for one application without touching the profile. Custom
questions are drafted by `application_writer` (claude:opus) sentence by sentence, each sentence
citing the facts it relies on (it may look up at most 3 more through Applyant's local MCP
endpoint). Every sentence is then checked: numbers and dates without a model (a contradicted
number is a hard flag, a number the facts don't have is confirmable), then by a separate
`claim_verifier` (claude:haiku) that sees only the sentences and the cited facts. Approve is
refused while a required value is missing, a sentence is flagged, or a relied-on fact is
unconfirmed.

Delivery: approval is the gate, and the daemon submits on its own after it. The web-form channel
opens the form in Applyant's own persistent Chrome profile (`$APPLYANT_HOME/browser`, branded
Chrome through Patchright, a headed window kept minimised), fills every step with the reviewed
values, uploads the profile's base CV, presses submit and waits for a confirmation. Anything the
deterministic fill can't operate goes to `form_agent` (claude:sonnet), scoped to one field or one
step, with five browser tools (`snapshot`, `fill`, `select`, `upload`, `click`) over the MCP
endpoint; it chooses how to operate a control, never what to enter. A captcha, a required field
with no reviewed value, or a step that won't advance ends in a hand-off: the window is restored
with the form filled, the application waits, and `handoff show` says what is left. A delivered
application is `applied` with a receipt of exactly what was sent (every value and its source,
the CV file hash, the final URL and the confirmation text).

```sh
pnpm -C daemon cli candidate profile set visa_sponsorship "No sponsorship needed in the EU"  # also:
pnpm -C daemon cli candidate profile set current_company Globex        #   relocation · current_title
pnpm -C daemon cli jobs apply <posting-id>                             # start (or re-start) by hand
pnpm -C daemon cli applications list
pnpm -C daemon cli applications preview <id>                           # every value and where it came from
pnpm -C daemon cli applications set-field <id> salary "70000 EUR/year" # this application only (#n, meaning or label)
pnpm -C daemon cli applications set-field <id> salary --clear          # back to the profile value
pnpm -C daemon cli applications set-field <id> Education '[{"School": "…", "Degree": "…"}]'   # a repeatable group
pnpm -C daemon cli applications confirm <id> [fact-id…]                # the unconfirmed facts it relies on
pnpm -C daemon cli applications edit <id> q2.3 "<your sentence>"       # your words → a confirmed fact
pnpm -C daemon cli applications edit <id> q2.3 --confirm               # a flagged number is true as written
pnpm -C daemon cli applications prepare <id> [--rewrite]               # again: current profile, overrides kept
pnpm -C daemon cli applications approve <id>                           # delivery starts on its own
pnpm -C daemon cli applications submit <id>                            # approve + deliver, or retry a stuck delivery
pnpm -C daemon cli handoff show <id>                                   # why delivery stopped, and what is left
```

Tailored CVs: when the form has a CV upload, preparation also writes a CV for the posting.
`application_writer` picks which projects lead, which facts become bullets, how the summary
reads and which skills come first, from confirmed facts only (never `team_context` facts), each
line citing its facts. Every line then goes through the same checks as answer sentences, and a
line that fails, or whose fact stops being confirmed, is left out of the CV (`preview` lists it
as dropped) rather than blocking approve. The CV is printed to PDF from an HTML/CSS template
(the bundled "Clean", or yours in `$APPLYANT_HOME/cv-template/`: `index.html` with `{{title}}`,
`{{style}}` and `{{cv}}`, plus `style.css`) and stored as `files/cv/<application>-<hash>.pdf`.
The Resume field points at that file, delivery uploads exactly that file (a changed file is not
sent), and the receipt keeps its hash. Without confirmed facts, or without `full_name`, the base
CV stands in, and `preview` says why.

```sh
pnpm -C daemon cli applications cv show <id>                           # what leads, each line with its facts, what was left out
pnpm -C daemon cli applications cv use-base <id>                       # send profile base_cv_file instead · cv use-tailored <id>
pnpm -C daemon cli applications cv edit <id> p1.2 "<your words>"       # a line (s1 · p1.2 · e1) → a confirmed fact, re-rendered
pnpm -C daemon cli applications cv edit <id> d1 "<your words>"         # a left-out line goes back in, in your words
pnpm -C daemon cli applications cv edit <id> p1.2 --remove
pnpm -C daemon cli applications prepare <id> --rewrite                 # write the answers and the CV again
```

Recorded forms: `pnpm -C daemon fixtures:record <url> --name <name> --about "<what it is>"` reads a
public application form (read-only, with a synthetic profile), saves the page as a HAR and the
decisions as JSON under `daemon/test/fixtures/forms/<name>/`, and replays it offline to check the
recording reproduces. `test/form-read.har.test.ts` replays every recording offline on each test run.

Live tests call the real agent CLIs and Jev (and spend quota), so they only run on request:

```sh
APPLYANT_LIVE=1 pnpm -C daemon test:live -t extractor
APPLYANT_LIVE=1 pnpm -C daemon test:live -t matcher    # also downloads EmbeddingGemma unless APPLYANT_MODELS_DIR has it
APPLYANT_LIVE=1 pnpm -C daemon test:live -t jev        # key from APPLYANT_JEV_KEY or the `jev` secret
APPLYANT_LIVE=1 pnpm -C daemon test:live -t "writer|verifier"   # opus writer + haiku verifier, seeded exaggerations
```

Schema changes: edit `daemon/src/db/schema.ts`, then `pnpm -C daemon db:generate --name <what>`
(never `drizzle-kit push`). Virtual tables (`facts_fts`, `facts_vec`) and their triggers live in
custom migrations (`pnpm -C daemon exec drizzle-kit generate --custom --name <what>`).
