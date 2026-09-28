---
task: local-job-search-agent-harness-system-2vuidu
type: structure-outline
repo: romirom11/applyant
branch: local-job-search-agent-harness-system-2vuidu
sha: 671a27792c5ae2bb895509963a5f6a8c398bde5c
---

# Applyant: phased build of the job-search harness

We build Applyant as the TDD describes. A TypeScript daemon (`applyantd`) owns all logic, with SQLite, one task queue, role-routed agents and a generic form engine. The CLI and a SwiftUI app are its thin Connect clients. The TDD's build order sets the phase order. Phases 1–7 build the core loop (knowledge → score → read form → prepare → review → deliver → CV) through the daemon and CLI on `ai-serv`. Phase 8a packages it for the Mac, and 8b puts it in front of the candidate. The agent interview comes next, so knowledge is rich before search starts filling the Inbox. Phases 10–16 add the periphery onto the working core.

## Desired End State

- `applyantd` runs as a launch agent inside a signed, notarised `Applyant.app`. The app, the Share extension and the `applyant` CLI talk to it only through the Connect API generated from `proto/applyant/v1/applyant.proto`.
- All state lives in `applyant.db` (SQLite WAL, FTS5, sqlite-vec). Secrets live behind one `Secrets` interface: a `0600` file on Linux and the Keychain on the Mac. Postings and applications move through their `stage` machines, driven by one lease-based task queue whose handlers never hold a transaction.
- Candidate knowledge is made of facts with evidence and `unconfirmed` / `confirmed` status. It's built from a CV, GitHub repos, files, URLs, Drive and the agent interview. The interview also fills facts that preparation finds missing.
- Postings arrive from strategies, feeds, ATS APIs, recipes, LinkedIn/Xing, Telegram, `jobs add` and the Share extension. Each is verified, deduplicated and given an explained 0–100 score from a pure `score()` function. A posting is closed because it's absent from a source only when that source returned a complete list.
- Applications are prepared for the real form, with sentence-level fact citations, number checks, a separate claim verifier and a tailored CV. Approve is blocked until nothing unconfirmed or flagged is left.
- Approved applications go out through the web-form, email or Telegram channel. Captchas go to CapMonster first. When delivery gets stuck, the candidate gets a hand-off window with the form already filled.
- Mail moves application status on its own, reads emailed security codes and creates Google Calendar events for interviews.

## Implementation Overview

- [x] Phase 1: A URL added from the CLI is verified by the daemon
- [x] Phase 2: Candidate knowledge from a CV and a GitHub repo, with facts to confirm
- [x] Phase 3: An added posting gets an explained 0–100 score
- [x] Phase 4: The real application form is read, including later steps
- [x] Phase 5: A prepared application is reviewed and approved from the CLI
- [x] Phase 6: Approved web-form applications are delivered, with hand-off
- [x] Phase 7: Each application gets a tailored CV
- [x] Phase 8a: Applyant.app installs, starts the daemon at login and finds the agent CLIs
- [ ] Phase 8b: The candidate runs the core loop from the Mac app
- [ ] Phase 9: The agent interview fills in what sources can't show
- [ ] Phase 10: Search strategies find postings on their own
- [ ] Phase 11: The agent discovers new boards and reads them with recipes
- [ ] Phase 12: Company research feeds the score and the answers
- [ ] Phase 13: The mailbox tracks status, reads security codes and sends email applications
- [ ] Phase 14: Captchas, logged-in sites, LinkedIn and Xing
- [ ] Phase 15: Telegram as a source and a channel
- [ ] Phase 16: Onboarding, Google Drive and the Share extension

## Where the work runs

| Work | Where | Verified by |
|---|---|---|
| Phases 1–7 and the daemon parts of 9–16 | `ai-serv` (Linux) | `pnpm -C daemon …` locally, plus the Linux GitHub Actions workflow |
| Phases 8a and 8b, and every `app/` or `native/` change after them | An agent session on the owner's Mac | `swift test` and `xcodebuild test` run locally. CI has no macOS runner, because macOS minutes cost 10× on a private repo and the product lives on this Mac anyway |

System changes on `ai-serv` (the Chromium headless shell in phase 1, Google Chrome and `xvfb` in phase 6) go into `~/ops/README.md` and get a dated entry in `~/ops/log.md`, per the machine's convention.

## Owner-only prerequisites

These need the owner's accounts or decisions, so an agent can't create them. Each one must exist before its phase starts, so none of them turns up mid-phase.

| Needed by | What | Stored as |
|---|---|---|
| Start of phase 4 | Owned ATS test boards: trial accounts on Workable, Ashby, and Greenhouse where available, with deliberately awkward test postings. The trials expire (Workable after 15 days), so the recorded HAR fixtures are what lasts, not the accounts. Record the fixtures while the trials are live | `daemon/test/fixtures/forms/*.har` |
| Phase 4 | Jev API key | `applyant secrets set jev` |
| Phase 13 | Google Cloud OAuth client of type "Desktop app", left "In production, unverified" | client id in config; tokens via `Secrets` |
| Phase 14 | CapMonster Cloud API key | `applyant secrets set capmonster` |
| Phase 14 | A LinkedIn login for Applyant's Chrome profile | signed in once through the login window |
| Phase 15 | A Telegram account for MTProto | GramJS session via `Secrets` |

---

## ✅ Phase 1: A URL added from the CLI is verified by the daemon

This is the walking skeleton. It stands up every layer the rest depends on: the proto contract, the Connect server and client, the SQLite schema with migrations, the lease-based queue with its `Outcome` / `commit` contract, the `Secrets` interface, the headless reader browser, and the `WatchEvents` stream. `applyant jobs add <url>` inserts a posting at `found` and enqueues `verify_posting`. That task opens the page in the Chromium headless shell and moves the posting to `verified` or `failed_verification`. There are no models yet: liveness here is deterministic (HTTP status, JSON-LD `validThrough`, and an apply link or form on the page).

### Change Outline

The repo starts empty, so this is the full initial shape. `daemon/` is the one pnpm package. It holds both the daemon and the CLI, so they share the generated client.

```text
applyant/
├── buf.yaml · buf.gen.yaml                 # generates connect-es into daemon/src/gen (swift added in 8b)
├── proto/applyant/v1/applyant.proto        # AddPosting · ListPostings · GetPosting · WatchEvents
├── daemon/
│   ├── package.json · tsconfig.json · vitest.config.ts · biome.json
│   ├── src/
│   │   ├── main.ts                         # composition root; writes {port, token} to a 0600 file
│   │   ├── config.ts                       # data dir (APPLYANT_HOME, defaults per OS); no secrets here
│   │   ├── secrets/
│   │   │   ├── secrets.ts                  # interface Secrets { get(name), set(name, value), delete(name) }
│   │   │   └── file-backend.ts             # 0600 JSON under APPLYANT_HOME (Linux); Keychain backend in 8a
│   │   ├── gen/                            # buf output (checked in)
│   │   ├── cli/index.ts                    # `applyant jobs add|list|show` · `runs show --follow` · `secrets set|list`
│   │   ├── rpc/server.ts · rpc/postings.ts # bearer-token check → domain → proto mapping
│   │   ├── db/
│   │   │   ├── schema.ts                   # postings · posting_sources · tasks · events
│   │   │   ├── client.ts                   # better-sqlite3, WAL, loads sqlite-vec on every connection
│   │   │   └── migrations/0000_init.sql
│   │   ├── queue/
│   │   │   ├── types.ts                    # Handler · Outcome · Commit
│   │   │   ├── worker.ts                   # tx1 lease → handler → tx2 (stillLeased check)
│   │   │   └── events.ts                   # in-process bus → WatchEvents
│   │   ├── browser/reader-pool.ts          # chromium-headless-shell, throwaway contexts
│   │   └── domain/search/verify.ts         # verify_posting handler
│   └── test/
│       ├── queue.worker.test.ts            # lease loss discards · retry backoff · crash requeue
│       ├── secrets.test.ts                 # file mode 0600 · values never appear in config or logs
│       ├── verify.test.ts                  # local fixture pages: live · 404 · closed JSON-LD · homepage apply
│       ├── fixtures/sites/                 # static HTML served by a test http server
│       └── e2e/cli.test.ts                 # spawns daemon on a temp APPLYANT_HOME, drives the CLI
└── .github/workflows/daemon.yml            # buf lint + generate diff · typecheck · lint · test (ubuntu)
```

The queue contract is set here, exactly as in the TDD, so every later handler slots in without changes to the worker.

```ts
type Outcome =
  | { kind: 'done'; commit: Commit }
  | { kind: 'retry'; after: Date; reason: string }
  | { kind: 'pause_provider'; provider: Provider; until: Date }      // used from phase 2
  | { kind: 'needs_candidate'; commit: Commit; handOff: HandOff };   // used from phase 5

tasks(id, kind, entity_id, run_id, provider, status, attempts, run_after,
      lease_owner, lease_expires_at)
postings(id, stage, canonical_url, title, company, first_seen_at, verified_at, verify_note)
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon install && pnpm -C daemon exec playwright install --only-shell --with-deps chromium`, with `~/ops/README.md` and `~/ops/log.md` updated
- [x] `buf lint && buf generate && git diff --exit-code daemon/src/gen`
- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint`
- [x] `pnpm -C daemon test` (queue, secrets, verify fixtures, CLI e2e)

#### Manual Verification

- [x] `applyant jobs add <a live Greenhouse posting>` and `<a closed one>`, then `applyant jobs list` shows `verified` and `failed_verification`, and `applyant runs show --follow` streams the task events.

---

## ✅ Phase 2: Candidate knowledge from a CV and a GitHub repo, with facts to confirm

This phase adds the model layer and the knowledge base together, so the first agent call does something the product needs. `candidate project add`, `candidate source add <project> file|url|github …` and `candidate sync` enqueue `sync_source` tasks. The `extractor` role turns each source into facts with evidence. GitHub facts about personal contribution come only from commits by the candidate's identities. Everything extracted starts `unconfirmed`, and `candidate fact confirm|edit` changes that. A PDF CV is read with `pdfjs-dist` in Node, so the candidate's real CV works from this phase on. It stays the fallback once `applyant-native` (PDFKit) takes over on the Mac in 8a.

### Change Outline

The model layer comes first, because every later phase goes through it. Code never names a provider. It asks for a role.

```diff
 daemon/src/
+├── models/
+│   ├── roles.ts              # routing table defaults · per-role confidence thresholds · fallbacks
+│   ├── agent-runner.ts       # role → provider · context · schema · stream → progress · agent_runs row + ndjson
+│   ├── providers/claude.ts   # @anthropic-ai/claude-agent-sdk query() with outputFormat json_schema
+│   │                         #   always passes pathToClaudeCodeExecutable (PATH lookup now, resolver in 8a)
+│   ├── providers/fake.ts     # scripted outputs for tests (no CLI spawned)
+│   ├── limits.ts             # "hit your session limit · resets 15:45" → pause_provider
+│   └── schemas/              # zod; strict (nullable, never optional)
+├── domain/knowledge/
+│   ├── projects.ts · facts.ts · evidence.ts
+│   ├── text/extract.ts       # interface TextExtractor; pdf.ts (pdfjs-dist) · docx fallback · native in 8a
+│   ├── sources/file.ts · sources/url.ts (readability) · sources/github.ts (partial clone + gh api)
+│   └── sync.ts               # sync_source handler → facts(unconfirmed) + evidence
 ├── queue/worker.ts
+│   ~ honours provider pauses when leasing
 └── cli/
+    └── candidate.ts          # show · project add|list|show · source add · sync · fact list|confirm|edit
 test/
+├── schemas.strict.test.ts    # z.toJSONSchema over models/schemas/* · keyword allowlist
+├── agent-runner.test.ts      # fake provider · limit message → pause_provider without attempts++
+│                             # SDK spawns exactly the passed path: fake `claude` script writes its argv to a file
+│                             #   (catches an SDK update silently switching to its bundled binary)
+├── pdf-extract.test.ts       # fixture CV PDF → expected text
+└── github-authorship.test.ts # fixture repo: others' commits become team_context, never personal_contribution
```

The TDD's fact contract lands as-is. `sources.kind` covers every source type now, even though only three readers exist yet.

```sql
projects(id, name, summary, role, period, stack)
sources(id, project_id, kind, locator, last_synced_at)   -- kind: file | url | github | drive | manual
facts(id, project_id, text, kind, status, origin)         -- unconfirmed | confirmed | rejected
evidence(fact_id, source_id, locator)                     -- path · commit SHA · PR · URL fragment
agent_runs(id, task_id, role, provider, model, duration_ms, tokens, outcome, log_path)
profile(key, value)                                       -- github logins + commit emails for now
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [x] `APPLYANT_LIVE=1 pnpm -C daemon test:live -t extractor` (runs the real `claude` once on a fixture CV)

#### Manual Verification

- [x] Add the candidate's real PDF CV and one of their GitHub repos. Check that `candidate fact list solovei` reads true, that each fact shows evidence, and that nobody else's work is phrased as the candidate's own.
  - [x] GitHub part (2026-09-27, `romirom11/solovei`): 109 facts. Each of the 92 personal_contribution facts cites a candidate-authored commit or PR, and its claim matches the cited work. The first run credited Claude-authored PR work to the candidate; that is fixed by the PR-authorship rule and the `claim_verifier` pass.
  - [x] Real PDF CV (`~/roman_kudin_cv.pdf`): 63 facts in 13 projects. All are faithful to the CV, with page and section evidence; periods and numbers match.
  - Owner decision: commits by the candidate's AI coding agents (Claude Code, Codex, Cursor, Copilot) count as the candidate's own work in repos they own or in PRs they opened or merged, with no AI label. Automation bots never count. After this change, solovei gives 715 of 726 commits as the candidate's, and 119 facts.

---

## ✅ Phase 3: An added posting gets an explained 0–100 score

Verified postings now flow on to `score_posting`. The `extractor` pulls structured requirements, salary, location and similar fields once (cached). The `matcher` classifies each requirement as strong, partial or missing, with fact ids, using hybrid retrieval over the knowledge base. The pure `score()` turns that into the number, its breakdown and any dealbreakers. `jobs show` prints the PRD's breakdown. `jobs skip --reason` and `jobs interested` record feedback that nudges weights within bounds. This phase also brings in embeddings and the FTS5/vec tables, because the matcher is the first thing that retrieves.

### Change Outline

```diff
 daemon/src/
 ├── db/migrations/
+│   ├── 0001_facts_fts.sql      # FTS5 external-content + sync triggers (custom migration)
+│   └── 0002_facts_vec.sql      # vec0, 256-dim
+├── db/read-pool.ts             # worker_threads read-only connections (each loads sqlite-vec)
+├── models/embeddings.ts        # embeddinggemma-300m ONNX via @huggingface/transformers, Matryoshka 256
 ├── domain/knowledge/
+│   └── retrieve.ts             # the one hand-typed RRF query (bm25 + vec MATCH)
+├── domain/scoring/
+│   ├── extract.ts · match.ts   # LLM steps, cached by posting text hash / fact version
+│   ├── score.ts                # pure: (ScoreInput, Preferences, Weights) → {score, breakdown, dealbreakers}
+│   ├── salary.ts · fx.ts       # normalise to target unit; unknown period/gross → "uncertain"
+│   └── handlers.ts             # score_posting → stage scored
 ├── domain/search/verify.ts
+│   ~ on verified: enqueue score_posting
 └── cli/
+    ├── prefs.ts                # `candidate prefs show|set` · dealbreakers · weights
+    └── jobs.ts                 ~ show prints breakdown · skip --reason · interested
 test/
+├── score.test.ts               # table tests: proportional penalties · dealbreaker ≠ zero · feedback cap
+├── retrieve.test.ts            # hybrid ranking on a seeded fact set
+└── rescore.test.ts             # prefs change re-runs score() only, no model calls
```

The score shape is what every client renders from here on.

```ts
interface Component { key: 'must' | 'nice' | 'role' | 'location' | 'remote' | 'salary' | 'language' | 'employment';
                      weight: number; value: number; note: string | null; uncertain: boolean }
interface RequirementMatch { text: string; must: boolean; verdict: 'strong' | 'partial' | 'missing'; factIds: number[] }
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [x] `APPLYANT_LIVE=1 pnpm -C daemon test:live -t matcher`

#### Manual Verification

- [x] Add 5 real postings you know well. Check that the scores and ✓/~/✗ lines match your judgement, and that re-running `jobs show` gives the same number.
  - 2026-09-27, with the real CV and solovei, on 6 postings: n8n Agentic Platform 88 · ElevenLabs Full-Stack 86 (location flag) · n8n FDE 75 (location flag) · ElevenLabs Research Inference 53 · Supabase Postgres AMER 37 · Blueground iOS Athens 19. Re-scoring gives identical numbers with no new agent_runs.
  - The first run's scores were compressed (86 down to 55). Four fixes: structured page data (header label, JSON-LD) beats the model's reading, and perks don't set the workplace; an unsplit requirements list counts as must-haves; logistics components scale with core fit (must-haves × role, counted in full from 70%, quadratic below); condition requirements (travel, right to work) are asked, not ✗ missing.

---

## ✅ Phase 4: The real application form is read, including later steps

The form engine's Read mode lands here. After verification, `read_form` opens the apply target in a throwaway context. It takes an `ariaSnapshot` across all frames, then dry-fills standard fields with the candidate's real profile values and questions with placeholders, discovering conditional fields and wizard steps. It stops before the final submit. The result is `Requirements`, stored on the posting. Verification gains "apply form verified". `field_classify` and `option_match` are the first Jev roles. The key comes from `Secrets`, with the `claude:haiku` fallback when Jev is off or unsure.

The owner creates the test boards at the start of this phase (see Owner-only prerequisites), because the form HAR fixtures are recorded from them.

### Change Outline

Dry-fill needs real standard values. With placeholders for a work-authorisation or country answer, `revealedBy` would record the wrong branch. So the profile gets its standard fields first.

```diff
 profile(key, value)
   github_logins · commit_emails
+  full_name · email · phone · location · work_authorization · salary_expectation
+  notice_period · links.github · links.website · links.linkedin · base_cv_file
```

```diff
 daemon/src/
 ├── cli/candidate.ts            ~ + `candidate profile set|show` (standard fields above)
 ├── browser/
+│   ├── snapshot.ts             # ariaSnapshot over all frames → FieldSpec[] with ElementRef(frame path, role, name, nth)
+│   ├── form-engine.ts          # fillStep() · advanceDeterministic() · mode: 'read' | 'deliver'
+│   └── form-read.ts            # dry-fill loop with profile values; never presses isFinal advance
 ├── models/
+│   ├── providers/jev.ts        # POST /v1/systemone; batched Choice per form; key via Secrets
+│   └── roles.ts                ~ field_classify · option_match · posting_liveness → jev, fallback claude:haiku
 ├── domain/search/verify.ts
+│   ~ posting_liveness via Jev · enqueue read_form
+└── domain/applications/read-form.ts   # read_form handler → postings.requirements
 test/
+├── form-read.har.test.ts      # routeFromHAR over fixtures/forms/*.har → expected Requirements JSON
+├── form-read.sites.test.ts    # local fixture forms: conditional reveal · 3-step wizard · cross-origin iframe · upload
+├── form-read.branch.test.ts   # work-auth "No" in profile → revealedBy records the "No" branch
+└── fixtures/forms/            # recorded owned-board forms + real forms met in the wild + expected output
```

`Requirements` and `FieldSpec` are the TDD shapes, unchanged. `revealedBy` is filled during the dry-fill.

### Validation

#### Automated Verification

- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [x] `pnpm -C daemon fixtures:record <url>` produces a HAR plus expected output that the test then replays offline
- [x] `APPLYANT_LIVE=1 pnpm -C daemon test:live -t jev` (added: the real Jev for field_classify, option_match and posting_liveness, no fallback; 9 requests, 12k input tokens, ~$0.0005)

Progress notes (2026-09-27):

- No owned ATS boards (owner decision). Fixtures come from two places instead:
  - **Public** (recorded read-only from real public application forms with a synthetic profile; nothing typed was sent, nothing submitted): `test/fixtures/forms/greenhouse-gitlab` (job-boards.greenhouse.io, GitLab "AI Engineer"), `ashby-ashby` (jobs.ashbyhq.com, Ashby "Engineering Manager - EU"), `lever-leverdemo` (jobs.lever.co, Lever's own demo board), `workable-huggingface` (apply.workable.com, Hugging Face). Each is a HAR zip plus `fixture.json` (URL, profile, recorded Jev/haiku decisions, expected `FormRead`); `form-read.har.test.ts` replays all four offline.
  - **Synthetic** (local pages in `test/fixtures/sites/`, modelled on observed ATS behaviour, for later steps that only a real submission would show): `form-conditional` (Greenhouse-style reveals), `form-wizard` (Workday-style 4 steps, required upload, step 3 depends on step 1), `form-wizard-saving` (each step saved server-side: Read stops at step 1 with a note), `form-embed` + `form-embedded` (cross-origin Greenhouse-style embed, react-select-like comboboxes, type-ahead location), `form-ashby` (yes/no toggles, autosave, "Autofill from resume"), `form-signin` (sign-in wall).
- Read never sends anything: `guardReadOnly` aborts every non-GET request except GraphQL queries. This matters in practice: Ashby autosaves each typed value (`ApiSetFormValue` mutation), and 28 of those were blocked on one read. Real wizards that save each step on the server (Workday) are therefore read only up to their first step, with a note.
- Additions beyond the outline: `posting.form` event; `jobs read-form [id…]` + `ReadForms` RPC; a startup catch-up that reads the forms of postings verified before Read existed; `postings.apply_url` recorded by verification (mailto → `form_status = email`, no read); sign-in walls reported as `no_form`; `APPLYANT_JEV_URL` override (tests).
- Manual-check fixes (2026-09-27, after comparing 5 real reads with the ATS form APIs):
  - Workable's GDPR consent now reads as required: the control is a `div[role=checkbox]` whose `*` is a CSS `::after`. Custom checkboxes are read instead of their hidden inputs, and a CSS-drawn `*` on a control counts as required.
  - Repeatable sections are a new `group` field kind: the ref is the section's "Add" control. Read presses it once, lists the entry's fields with `revealedBy {value: "add"}`, then cancels the entry. Workable's Education and Experience now match the API.
  - Lever's disability "Name" / "Date" stay required: the page sets `required` on both once Disability status is answered. `required` on a conditional field is now documented, and shown, as "required on that branch".
  - ATS form APIs are used only as test-time ground truth (`test/form-read.ats.test.ts`, with Workable's API saved as `ats-form.json`). Reading them at read time would be the per-ATS form adapter the TDD rules out.
  - Questions that point back to the job description are noted, e.g. Hugging Face's "exact phrase" check.
  - All four public fixtures were re-recorded.

#### Manual Verification

- [x] Run `applyant jobs show <id> --form` on each owned test board, plus one real company-site form. Check that every field, required flag, option list and later step is listed.
  - Without owned boards: run it on one real public posting per ATS (Greenhouse, Ashby, Lever, Workable), plus one real company-site form, and compare with the live page by eye.
  - 2026-09-27, owner decision: no owned test boards. Checked 5 real forms, read-only with a synthetic profile (GitLab and Anthropic on Greenhouse, Ashby, Lever demo, Hugging Face on Workable), against each ATS's own form definition: Greenhouse `?questions=true`, the Ashby GraphQL applicationForm, the Workable `/api/v1/jobs/<id>/form` and Lever's page HTML. Greenhouse and Ashby matched exactly the first time. Fixed after the check: the Workable consent is required (custom checkbox with a CSS-drawn `*`), Workable Education and Experience are read as repeatable groups, and Lever's disability signature is required only once that section is answered. A required question that refers back to the job description (Hugging Face) is flagged as a note for Phase 5.

---

## ✅ Phase 5: A prepared application is reviewed and approved from the CLI

This phase is the centre of the product. A scored posting at or above the threshold (or marked `interested`) creates an application at `preparing`. `prepare_application` fills in standard fields from the profile. For each question it builds the `WriterContext` and runs `application_writer` to get sentences with fact ids, then runs the number check and the separate `claim_verifier`. The application reaches `ready_for_review`. `applications preview` shows what the review screen will show. `fact confirm`, `applications edit` (which saves `review_edit` facts) and `applications approve` complete the gate. Approve is refused while any unconfirmed fact or flagged sentence remains. In this phase approval only moves the application to `approved`. Delivery is phase 6. A missing fact ends in `needs_candidate` for now. Phase 9 turns it into an interview question.

### Change Outline

```diff
 daemon/src/
 ├── domain/applications/
+│   ├── prepare.ts              # prepare_application handler; missing standard value / fact → needs_candidate
+│   ├── standard-fields.ts      # FieldMeaning → profile value; branch choice via revealedBy
+│   ├── writer-context.ts       # ALL projects index · matcher matches · retrieved · prior answers
+│   ├── checks/numbers.ts       # extractQuantities · contradiction (hard) · absent (confirmable)
+│   ├── checks/verify.ts        # claim_verifier run: sentences + cited fact text only
+│   ├── review.ts               # confirm · edit → confirmed review_edit fact · approve gate
+│   └── reuse.ts                # prior answers with factIds + verdicts
+├── mcp/server.ts               # streamable-HTTP MCP on 127.0.0.1; per-task token; call caps
+│   └── tools/knowledge.ts      # search_facts · get_project (≤ 3 calls per writer task)
 ├── domain/scoring/handlers.ts
+│   ~ threshold + no dealbreaker → create application, enqueue prepare_application
 └── cli/applications.ts         # preview · edit · approve · list
 proto/applyant/v1/applyant.proto
+  ~ GetApplication · EditAnswer · ConfirmFact · ApproveApplication
 test/
+├── numbers.test.ts             # "team of 10" vs "team of 4" · "5+ years" from 2019–2024 → absent
+├── approve-gate.test.ts        # blocked by unconfirmed · by hard flag · unblocked after edit
+├── citable.test.ts             # every factId ∈ ctx, incl. tool-fetched facts
+└── mcp-caps.test.ts            # 4th search_facts call refused
```

The application's stored shape is what review, delivery and history all read.

```sql
applications(id, posting_id, stage, channel, prepared_at, approved_at, applied_at)
answers(id, application_id, question_ref, adapted_from)
answer_sentences(answer_id, idx, text, fact_ids_json, flag)   -- flag: none | unconfirmed | absent_number | contradiction | verifier:<issue>
field_values(application_id, field_ref, value, source)        -- profile | answer | file
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test` (28 files, 217 tests; `buf lint && buf generate` clean)
- [x] `APPLYANT_LIVE=1 pnpm -C daemon test:live -t "writer|verifier"` (a seeded exaggeration must be flagged)
  - 2026-09-27, real claude on a synthetic candidate: "team of 10" against "one of 4 engineers" → `contradiction` (no model); "designed and built the entire platform" against a billing bug fix → `verifier:scope`; the team's Kubernetes work as "I ran" → `verifier:role`; an uncited Rust claim → `verifier:unsupported`; the true sentence and a motivational one pass (haiku). The opus writer used 2 `get_project` lookups over MCP, cited only given facts, began the first written answer with the phrase the posting asked for, and left the non-compete question to the candidate (`needs_candidate`).

Progress notes (2026-09-27):

- The owner's requirement is in: profile values are defaults only (no candidate value in code, defaults or fixtures; tests use a synthetic candidate). Every field can be set for one application (`applications set-field <app> <#|meaning|label> <value>`, `--clear` restores the prepared value; `SetFieldValue` RPC). `field_values.source` is `profile | override | answer | file | rule | none`; the prepared default is kept next to an override (`default_value`, `default_source`), so re-preparation recomputes the default and keeps the override. A value the profile lacks is never guessed: the field is `missing` and the application `needs_candidate`.
- Profile gained `visa_sponsorship`, `relocation`, `current_company`, `current_title` (defaults like the rest). Sponsorship is never borrowed from work authorisation in Prepare (Read still uses it as a dry-fill fallback).
- Phase 4 follow-ups: questions pointing back at the posting are marked for the writer, which gets the posting text (≤ 14k chars); group entry fields are filled only through their group (a JSON list of entries); loose classifications are guarded (links whose label names something else, date fields, dialling-code lists from the phone's code, yes/no authorisation answers matched by option_match with a "doesn't settle this" option, so an EU answer never says Yes to a US question). `test/prepare.fixtures.test.ts` runs Prepare over the four recorded public forms.
- Deviations: one writer run per application (questions refer to each other, e.g. "did you start your first answer with the phrase…"), and one verifier call per application in batches; `prepare_application` runs in two passes like scoring (fields + writer, then checks), so a verifier limit never loses the writer's output. "Relies on an unconfirmed fact" and "cites a rejected fact" are derived when shown, not stored; stored flags are `unchecked | none | absent_number | contradiction | verifier:<issue>`. The posting keeps its stage; the application carries its own (`preparing → ready_for_review ⇄ needs_candidate → approved`), and `Posting` shows its application.
- Additions: `ListApplications`, `PrepareApplication` (`jobs apply <posting>`, `applications prepare <app> [--rewrite]`: current profile, overrides and edits kept), `ConfirmFact.application_id` (`applications confirm <app> [ids]`), `EditAnswer` with confirm-as-written (not for contradictions), an `application.stage` event, a startup catch-up that starts applications for postings that qualified before this phase. Consent is given by approving and a required demographic question gets its "decline" option (source `rule`); optional custom and demographic questions are left empty. Email-channel postings wait in `needs_candidate` until phase 13.

#### Manual Verification

- [ ] Prepare one real application end to end, then time it with the stopwatch from `preview` until `approve` succeeds. This is the first reading of metric #3.
  - 2026-09-27, mechanics verified on the real CV and solovei knowledge with a synthetic contact profile, for Ashby "Engineering Manager - EU" (14 fields, 3 long questions). Checked: prepare → needs_candidate; per-application `set-field` overrides survive `applications prepare` and leave the profile unchanged; approve is refused while a flagged sentence or unconfirmed facts remain; after `edit` + `confirm`, approve succeeds. The timing (metric #3) still needs the owner to write their own answers to the two questions the system correctly handed back, so it is left open.
  - Cosmetic follow-up: preview still prints the "NEEDS YOU" prompt under q1/q3 after the owner has set their own value.
- [x] Read every answer and check that none of them invents experience (metric #4).
  - q1 (best engineers) and q3 (a difficult decision) were handed to the candidate because no facts cover them. q2 is built only from cited solovei facts; the verifier flagged the one inferred sentence (q2.4, "every new PBX opens the product to more teams").

---

## ✅ Phase 6: Approved web-form applications are delivered, with hand-off

Approval now triggers `deliver_application` through the web-form `Channel`. Delivery uses Patchright with branded Chrome and a persistent profile under `browser/`, in a minimised headed window. It fills with the same `fillStep` loop in `deliver` mode. The field-scoped and step-scoped agent escalations use Applyant's five browser MCP tools. The task submits, checks for confirmation and records a receipt. Anything unexpected ends in `needs_candidate`, and the window is kept open and filled for the hand-off. Until phase 7, the file field uploads the profile's `base_cv_file`. Captchas go straight to hand-off until phase 14.

On `ai-serv` the headed window runs under `xvfb`, where nobody can see it. So this phase checks hand-off with an automated test (the page is left filled and the task is `needs_candidate`). The by-hand check that a person can actually finish the form moves to 8b.

### Change Outline

```diff
 daemon/src/
 ├── browser/
+│   ├── submit-profile.ts       # launchPersistentContext(browser/, channel 'chrome', headless false, viewport null)
+│   ├── window.ts               # CDP Browser.setWindowBounds minimise / restore for hand-off
+│   └── form-engine.ts          ~ deliver mode: agentFillField · agentFixAndAdvance · handOff('field'|'step')
+├── mcp/tools/browser.ts        # snapshot · fill · select · upload · click, bound to the task's page
+├── channels/
+│   ├── channel.ts              # interface Channel { read, deliver }
+│   └── web-form.ts             # read = phase-4 reader · deliver = fill + submit + confirm
+├── domain/applications/deliver.ts   # deliver_application → applied | needs_candidate · receipt snapshot
 └── cli/applications.ts         ~ `applications submit <id>` = approve + deliver · `handoff show <id>`
 test/
+├── deliver.sites.test.ts       # local fixture forms: conditional fields · wizard · validation error → agent (fake) → submitted
+├── handoff.test.ts             # missing value / captcha fixture → needs_candidate, page left filled, window restored via CDP
+└── receipt.test.ts             # every field value, CV version and salary recorded
```

### Validation

#### Automated Verification

- [x] Google Chrome `.deb` and `xvfb` installed on `ai-serv`, with `~/ops/README.md` and `~/ops/log.md` updated
- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && xvfb-run pnpm -C daemon test` (31 files, 223 tests; `buf lint && buf generate` clean)

Progress notes (2026-09-27):

- **Patchright, added and isolated.** `pnpm add patchright` (pinned to the same `1.63.0` as `playwright`). `browser/submit-profile.ts` is the only file that imports it (dynamic `import('patchright')`, cast to Playwright's public `BrowserContext`/`Page`); everywhere else — `form-deliver.ts`, `form-agent.ts`, `channels/web-form.ts`, the MCP browser tools — only sees Playwright's types, per the outline's isolation rule. `launchPersistentContext(<home>/browser/, { channel: 'chrome', headless, viewport: null })`; on failure it falls back to Playwright's own bundled `chromium.launchPersistentContext` (branded Chrome still, if `channel: 'chrome'` fails) and, failing that, to plain Playwright Chromium (the TDD's "Chrome for Testing" fallback), each with a `log.warn`. No `allowBuilds` entry was needed (Patchright ships no install script). `SubmitProfile.deliver()` serialises deliveries with a promise queue (one at a time) and exposes `openPages()` for tests/diagnostics.
- **Window minimise/restore** (`browser/window.ts`) uses a CDP session from `context.newCDPSession(page)` and `Browser.getWindowForTarget` / `Browser.setWindowBounds`; `getWindowBounds()` is exported for tests. Verified for real under `xvfb-run` in `handoff.test.ts` (a genuine `windowState` check, not a mock).
- **Form engine, deliver mode.** `fillStep` (form-engine.ts) gained one new hook, `agentField(field, value, reason) => Promise<boolean>`, called only when the deterministic `fillField` fails and only in `deliver` mode; the deterministic pass is unchanged and Read is untouched. A new `submitFinal`/`waitForOutcome` pair (also form-engine.ts) presses the step's final control and waits for a navigation, the form's controls disappearing, or confirmation-like text — the same three signals a person would look for — else reports the page's own error/alert text back for the step agent. `browser/form-deliver.ts` (new, not a `~` to form-engine.ts as the outline sketch implied — it's a sibling orchestration file, symmetric with `form-read.ts`) drives one delivery: step loop, captcha check, missing-value / new-field / hand-off decisions. `browser/form-agent.ts` (new) holds the two agent runs (`agentFillField`, `agentFixAndAdvance`) and their prompts, kept out of form-engine.ts/form-deliver.ts so those stay free of `models`/`mcp` imports.
- **`form_agent` role** already existed in `models/roles.ts` from the file layout the earlier phases left in place (`route: claude:sonnet`); this phase only added `TASK_ROLE.deliver_application = 'form_agent'` and taught `FakeProvider` nothing new — it's already fully generic (scripted per-role replies), and `test/helpers/applications.ts`'s `scriptedClaude()` gained a `formAgent` script hook alongside its existing writer/verifier/option_match ones.
- **Browser MCP tools** (`mcp/tools/browser.ts`): `snapshot` (all-frames `ariaSnapshot` text), `fill`, `select` (native `<select>` via `selectOption`, else opens the control and clicks the matching `option`/`radio`/`checkbox` by name), `upload`, `click` — five, over the public Playwright API, using the same `{frame, role, name, nth}` ref shape as `FieldSpec`. Bound to a task's live page via a small new `browser/task-pages.ts` registry (`taskId → Page`), because the one long-lived `McpHub` serves every task through one endpoint. This needed one small, backward-compatible extension: `McpTool.run(args, signal, taskId)` — the existing knowledge tools ignore the new third argument (object-literal methods type-check bivariantly, so nothing else changed).
- **`channels/channel.ts`** matches the TDD's `interface Channel { read, deliver }` (`read(o: ReadFormOptions): Promise<ReadFormResult>`, so it's the exact phase-4 signature, not a re-abstraction of it). `domain/applications/read-form.ts`'s handler still calls `browser/form-read.ts` directly rather than through a `WebFormChannel` instance — deliberately, to put zero risk on the phase-4/5 read path — but `channels/web-form.ts.read()` is a real, working, tested delegation to the same function, so the interface isn't decorative.
- **Repeatable groups are out of scope for Deliver** (a deviation, called out explicitly): a `field_values` group with entries hands off immediately, before a browser is even opened (`"<label>" is a repeatable section with entries: delivery doesn't fill those in yet`). Filling N entries live (press "Add", match sub-fields by label, repeat) is a meaningful chunk of work in its own right and no owned test board exists to shape it against; left for a follow-up phase note.
- **The "new field only Deliver discovers" case** (TDD: "if `field_classify` marks it a standard field the profile has, the application goes back to Prepare with that value added, and returns to review") is implemented, restricted to plain text/textarea standard fields with no options (choice-field option-matching mid-delivery was judged too large an addition for this phase): `deliver.ts`'s `new_field` outcome adds a `field_values` row (`source: 'profile'`) and moves the stage back to `ready_for_review` — **not** `needs_candidate`, so it reads as "back for a fresh look", not "delivery is stuck" (see the stage note below). No test forces this path (it needs a form whose fields differ between the Read-time and Deliver-time DOM); the field-classify wiring itself was exercised live in the manual smoke test.
- **Stage: added `applied`, not `delivering`/reused `needs_candidate`.** `APPLICATION_STAGES` gained one member, `applied` (`appliedAt` already existed as a column from phase 5's own forward-looking schema). A stuck delivery leaves the stage at `approved` (the human gate already passed and isn't undone) with a `note` and a hand-off record, rather than moving it to `needs_candidate` — reusing that stage post-approval would make `applications preview`'s existing "Approve is blocked…" / "Ready: `applications approve`" messaging say the wrong thing (the application doesn't need re-approving, it needs the browser window finished or `applications submit` run again). A dedicated `handoff` event kind (proto `HandOffEvent`, `EventKind` in `queue/events.ts`) covers the outline's "so `runs show --follow` shows delivery progress" ask; the generic `task.needs_candidate` event already fires too.
- **Hand-off detail travels through the existing `tasks.note` JSON**, not a new table: `HandOff` (`queue/types.ts`) gained an optional `browser: { scope, step, fieldLabel, url, snapshotPath }`. `applicationView()` (store.ts) reads it back off the most recent `needs_candidate` `deliver_application` task for the application, so `GetApplication`/`GetHandOff`/`applications preview`/`handoff show` all show the same thing from one source.
- **Receipt**: new `receipts` table (`0008_delivery.sql`, plain `drizzle-kit generate`, unique on `application_id`; checked the generated SQL by hand — a straight `CREATE TABLE` + unique index, nothing custom needed). Stores the final URL, confirmation text, CV path/hash, salary value, submission time and a JSON array of exactly what was sent (ref, label, value, source) — built once, after `deliverForm` reports success, straight from the application's own `field_values`/`FieldView`s (not accumulated via a side-effecting callback during the fill loop: an earlier version double-recorded every field because `form-deliver.ts` also calls the value lookup once more, harmlessly, to build the step-agent's prompt — the manual smoke test caught this, and the fix — reading the receipt straight from the settled `ApplicationView` — is simpler than the callback it replaced).
- **CLI/proto**: `applications submit <id>` (approve if needed, then always re-enqueue delivery — so it doubles as "retry a stuck delivery"); `handoff show <id>` (new top-level `applyant handoff` namespace, not nested under `applications`, matching how the outline names it). Proto additions: `APPLICATION_STAGE_APPLIED`, `Application.applied_at`/`receipt`/`hand_off`, `Receipt`/`ReceiptFieldValue`/`HandOff` messages, `SubmitApplication`/`GetHandOff` RPCs, `HandOffEvent` on `Event.payload`. `buf lint` clean; `buf generate` re-run and re-checked idempotent (no further diff on top of what's committed).
- **Startup catch-up**: `catchUpDeliveries` (deliver.ts) enqueues delivery for any `approved` application with no receipt yet, mirroring the phase-5 `catchUpApplications` pattern; wired into `main.ts` alongside it.
- **Fixtures added** (`test/fixtures/sites/`): `form-deliver-simple.html` (an `<input type=range>` — reads as the form engine's `unknown` kind — for the field-agent escalation, plus a resume upload and a salary field, for `receipt.test.ts`), `form-deliver-confirm.html` (a submit that needs pressing twice — a `role=alert` "click again to confirm" — for the step-agent escalation), `form-deliver-wizard.html` (a plain 2-step wizard, no agent needed, to check multi-step Deliver on its own). No fake-captcha-widget fixture was added: captcha detection (`browser/form-deliver.ts`'s `detectCaptcha`, matched against known hosts and the `google.com/recaptcha` path) is instead checked as a pure function over a stub `Page` in `handoff.test.ts` — an offline captcha *iframe* would need to actually reach `google.com`/`hcaptcha.com` to have a URL worth matching, which the task's own "tests (vitest, offline...)" rule rules out; this is flagged as a real gap the owner should know about, not silently substituted.
- **`test/helpers/applications.ts`'s `prepareHarness`** is now the one harness for phase 5 *and* 6 tests: it always wires `deliver_application`, a real `SubmitProfile` (headless by default; `{ headless: false }` for tests that need a real window) and a `WebFormChannel`, alongside the existing `prepare_application` wiring — so `deliver.sites.test.ts`, `handoff.test.ts` and `receipt.test.ts` run the *real* Read → Prepare → approve → Deliver pipeline against local fixture forms, not a stubbed one. Phase 5's own tests (`prepare.test.ts`, `approve-gate.test.ts`, …) are unaffected — `deliver_application` is simply never enqueued in those tests since posting fixtures there aren't reached through `approveApplication`'s new auto-enqueue in every case, and where they are, the delivery task just sits `queued` harmlessly since those tests don't call `worker.idle()` again afterward.
- **An existing test needed a fix, not a new mock**: `test/e2e/cli.test.ts`'s "secrets never leak" test walks the whole daemon home directory; once `applications approve` started really auto-enqueuing delivery, that walk started hitting the profile's `SingletonCookie`-style symlinks (Chrome writes these to a profile directory itself, some intentionally dangling for lock detection) and failing on `readFileSync`. Fixed by having the walk skip symlinks (`lstat`) and only scan plain files — a correctness fix to a test that predates a browser ever running in that directory, not a suppression.
- **Not added**: a dedicated CLI e2e case for `applications submit` (the outline's "if cheap"). The existing e2e `approve` test already now exercises the real approve → auto-deliver → RPC/CLI path (see the fix above), and `applications submit`/`handoff show` were exhaustively checked in the manual smoke test below; a *second* e2e path that reliably completes a real headed delivery from the spawned e2e daemon (which doesn't expose a headless-Chrome switch) was judged not cheap enough to add on top, given the time this phase already took.

#### Manual Verification

- [x] Submit through the CLI on local fixture forms (`applications submit`), end to end, with the real daemon, the real `claude` CLI as `form_agent`, real headed Chrome under `xvfb-run`, and a real local HTTP server standing in for a job board — not owned ATS boards (no owned boards exist; see phase 4's note). `jobs add` → verify → `read-form` → `jobs apply` → `applications preview` → `applications submit` → `applications preview` showed `stage: applied` with a full receipt (7 field values incl. source, CV path + sha256 hash, salary, confirmation text, final URL); the `form_agent` genuinely ran (`claude-sonnet-5`) and used `snapshot`/`fill` over the real MCP endpoint to set the one field (`<input type=range>`) the deterministic pass can't operate. A second posting, with the CV file deleted after approval (a real race, not a contrived one), produced `needs_candidate`: `handoff show` printed the reason (the exact `ENOENT` from the failed upload — the field agent tried too, via `upload`/`click`, and still couldn't, because the file was genuinely gone), the field (`Resume`), the window's URL, and a full page snapshot; the browser window was left open and restored (checked live, not just asserted in the automated test). Restoring the file and running `applications submit` again then delivered it, with exactly 7 (not 14 — see the receipt fix above) field values recorded. **Owned test boards**: still none (owner decision, unchanged since phase 4); this line item can't be completed as written and is left unticked for that reason, not because delivery wasn't checked.
- [ ] Submit on the owned test boards that are still live. Check that each receipt matches what the ATS dashboard received. *(No owned boards exist — see phase 4's note and the line above. Left open for the owner.)*

---

## ✅ Phase 7: Each application gets a tailored CV

Preparation now also runs `application_writer` for the CV. It picks the projects to lead with, the achievements and the summary, using confirmed facts only. It renders the candidate's HTML/CSS template to PDF. `applications preview` shows the CV card (what was emphasised), `applications cv use-base` swaps in the base CV, and delivery uploads the exact stored PDF. Edits made to CV content are saved as facts, just like answer edits.

### Change Outline

```diff
 daemon/src/domain/applications/
+├── cv/select.ts                # cv_plan schema: project order · bullets(factIds) · summary
+├── cv/render.ts                # template + plan → PDF under files/cv/<application>.pdf
+│                               #   page.pdf() only through the reader pool (headless shell);
+│                               #   the headed Patchright submit profile can't print to PDF
+└── cv/templates/clean/         # index.html · style.css (candidate can replace)
 ├── prepare.ts                  ~ enqueue cv plan; unconfirmed fact in plan → excluded, not flagged
 └── deliver.ts                  ~ upload application's CV file; receipt stores its hash
 test/
+├── cv-select.test.ts           # only confirmed facts reach the plan
+└── cv-render.test.ts           # PDF text (pdfjs-dist) contains plan bullets
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon typecheck && pnpm -C daemon lint && xvfb-run pnpm -C daemon test` (34 files, 240 tests; `buf lint && buf generate` clean)

Progress notes (2026-09-28):

- Built as outlined, plus: `cv/store.ts` (the `cvs` row, the Resume field following it, `cv use-base | use-tailored | edit | show`), `review-fact.ts` (answer and CV edits share it), migration `0009_tailored_cv`, and `SetCvMode` / `EditCv` RPCs with a `Cv` card on `Application`.
- The CV is its own pass inside `prepare_application`, between the writer and the checks: `pending` → plan (opus, confirmed facts only, never `team_context`) → the same checks as answer sentences → `planned` → PDF via the reader pool → `ready`. A limit mid-CV never loses the drafted answers.
- A line that fails a check, or whose fact stops being confirmed, is left out of the CV and listed as dropped (`d1`…). A skill counts only if a confirmed fact names it. Only a line whose fact is rejected *after* the CV was made blocks approve (it's already in the PDF).
- Fallbacks: no confirmed facts, or no `full_name` → the base CV is sent, and preview says why. A re-prepare re-renders (the header may have changed); `--rewrite` writes the CV again.
- PDFs are stored as `files/cv/<application>-<hash>.pdf`, so a new render never overwrites a reviewed file. Delivery refuses to send a tailored PDF whose hash no longer matches (hand-off, nothing sent).
- No live test for the CV writer yet: the manual check below is the first run with real facts.

#### Manual Verification

- [x] Compare the tailored CVs for an AI Engineer posting and a Founding Engineer posting. Check that the emphasis differs and every line is true.
  - 2026-09-28, real daemon + real `claude` (opus writer, haiku verifier) on the owner's real CV (54 facts in 13 projects, all confirmed for this check), with a placeholder contact profile. Two synthetic postings ("Senior AI Engineer", Lumen Health; "Founding Engineer", Tallyhall) on the recorded Greenhouse form, scored 82 / 85, so both applications started on their own.
  - The emphasis differs: the AI CV leads with Tech Lead at NDA (RAG, LLM integrations), Solovei (STT + LLM analysis), the local Whisper/Gemma voice pipeline and the agent-operated infrastructure. Its skills are Python · FastAPI · RAG · pgvector · Whisper · vLLM… The Founding CV leads with ordi (CRM + invoicing ops platform, the closest match to the posting's product), then NDA leadership and ASG "team from zero", then Octify. Its skills are TypeScript · React · Hono · Drizzle · Tauri…
  - Every line checked against its facts. Nothing is invented. One wording is stronger than its fact: "Configured the agents to watch the infrastructure…" against #33 "The agent setup watches…" (the verifier let it through). The verifier left out an AI summary sentence that claimed "sales calls" from facts that didn't say so. Each CV fits on one A4 page.
  - A bug found and fixed here: the skill filter dropped skills ending in punctuation ("CI/CD (GitHub Actions)", "Node.js (NestJS)"), because the closing bracket became a trailing space. `words()` now normalises tokens, with a test.

---

## ✅ Phase 8a: Applyant.app installs, starts the daemon at login and finds the agent CLIs

> Owner decision (2026-09-28): Applyant is for the owner's own Mac only. No Apple Developer Program, Developer ID or notarisation; the bundle is signed ad-hoc and installed locally. `SMAppService` is tried first, with a `~/Library/LaunchAgents` + `launchctl bootstrap` fallback if macOS refuses an ad-hoc app. Wherever this phase says "notarised" or `spctl`, read "ad-hoc signed" and `codesign --verify --deep --strict`. The session brief was `handoff-phase-8a-mac.md` (`docs/phase-8a-mac.md` until 8a was done; its content is in the progress notes below).

This phase is packaging only, and it runs in an agent session on the Mac. Signing native modules, notarisation, `SMAppService` and launchd are a different class of problem from SwiftUI, so they surface before any time goes into views. The result is a notarised `Applyant.app` that:

- registers the launch agent;
- starts `applyantd` from the bundled Node;
- talks to `applyant-native`;
- stores secrets in the Keychain;
- ships a CLI that works from the bundle;
- shows a menu bar item with status only.

A launchd agent doesn't inherit the shell `PATH` (the same class of problem as `environment.d` on `ai-serv`). So the daemon looks for `claude` and `codex` itself, at explicit paths, and passes the resolved paths to the SDKs. The new `GetSetupStatus` RPC reports where each one was found, or that it's missing and why.

### Change Outline

```diff
 applyant/
+├── native/                     # Swift package: applyant-native
+│   ├── Sources/…/main.swift    # JSON-lines loop
+│   ├── ExtractText.swift       # PDFKit · AppKit (DOCX)
+│   ├── Keychain.swift          # keychain_get / keychain_set / keychain_delete
+│   └── Wake.swift              # NSWorkspace didWake → {"event":"wake"}
+├── app/                        # Xcode project, minimal
+│   └── ApplyantApp.swift       # SMAppService register on first launch · MenuBarExtra: daemon status only
+├── scripts/
+│   ├── bundle.sh               # node + daemon + helper → Applyant.app; codesign every *.node; notarise; staple
+│   └── smoke-bundle.sh         # launch bundled daemon · bundled CLI → GetSetupStatus + ListPostings
 └── daemon/src/
+    ├── native/client.ts        # spawns applyant-native; request/response + events; Linux stub = "unavailable"
+    ├── secrets/keychain-backend.ts   # via native; chosen on darwin, file backend elsewhere
+    ├── models/cli-paths.ts     # resolve claude · codex
+    ├── rpc/setup.ts            # GetSetupStatus
+    ├── domain/knowledge/text/extract.ts   ~ darwin → native.extract_text; pdfjs-dist stays as fallback
+    └── queue/scheduler.ts      ~ wake event → run each missed schedule once
```

The CLI lookup order and the status shape come first, because the menu bar, `applyant status`, and onboarding (phase 16) all read them.

```text
resolve(tool):  $APPLYANT_<TOOL>_PATH
              → ~/.local/bin/<tool>
              → ~/.npm-global/bin/<tool>
              → /opt/homebrew/bin/<tool>
              → /usr/local/bin/<tool>
              → login-shell probe: <shell> -ilc 'echo __APPLYANT__; command -v <tool>'
                  (last resort; run once at daemon start and cached, never per task,
                   because a login shell with nvm/pyenv in the profile can take 1–2 s)

probe shell:  $SHELL, unless it is unset, empty or /bin/sh (launchd may not pass it)
            → dscl . -read /Users/$USER UserShell
            → /bin/zsh (macOS default)
-i as well as -l: zsh reads ~/.zshrc only for interactive shells, and nvm usually lives there.
Output after the marker line is parsed, so profile noise (banners, prompts) is ignored.
The probe has a timeout, and a failed probe counts as "not found".
claude provider: query({ options: { pathToClaudeCodeExecutable: resolved } })   # never the SDK's bundled binary
codex provider:  new Codex({ codexPathOverride: resolved })
```

```diff
 message SetupStatus {
+  ToolStatus claude = 1;     // { found, path, version, signed_in, error }
+  ToolStatus codex  = 2;
+  bool native_helper = 3;    // applyant-native reachable
+  string secrets_backend = 4; // "keychain" | "file"
 }
```

### Validation

#### Automated Verification

- [x] `pnpm -C daemon test` still green on Linux (native stub, file secrets, `cli-paths.test.ts` over a fake HOME: lookup order, the shell probe runs once however many tasks resolve, SHELL unset / empty / `/bin/sh` falls back to the `dscl` shell and then `/bin/zsh`, and profile noise before the marker is ignored). 36 files, 263 tests on the Mac too; Linux CI green on every 8a push
- [x] `swift test --package-path native` (Mac): 9 tests. Also `swift test --package-path app` and `xcodebuild -scheme Applyant-Package -destination 'platform=macOS' test` in `app/` (9 tests)
- [x] `scripts/bundle.sh && codesign --verify --deep --strict /Applications/Applyant.app && scripts/smoke-bundle.sh` (Mac; ad-hoc, so `codesign --verify` instead of `spctl`)

Progress notes (2026-09-28, on the owner's Mac: macOS 27, Xcode 26.2, Node 24.21 via nvm next to the default 22):

- **CLI lookup** (`models/cli-paths.ts`) is the planned order. Two differences: the login shell prints `$PATH` after the marker instead of `command -v <tool>` (zsh's `command -v` prints an alias's definition, not a path), and the probe is started at daemon start without blocking it; the first resolve that needs it waits on the one cached promise. A found CLI's own directory leads its child PATH, because nvm's `codex` is a `#!/usr/bin/env node` script and launchd's PATH has no `node`. `claude.ts` lost its PATH lookup; `$APPLYANT_<TOOL>_PATH` pointing at a non-executable is reported, not skipped.
- **`GetSetupStatus`** adds `found_via`, the daemon's `pid`, `home`, `started_at` and `checked_at` to the planned shape. Version and sign-in come from `<tool> --version` and `claude auth status` (JSON `loggedIn`) / `codex login status` (exit code), cached for a minute (`--refresh` re-runs them). `applyant status` prints it.
- **applyant-native** (`native/`, Swift 6 package): JSON lines, one answer per `id`, `{"event":"wake"}` unsolicited; requests on a reader thread, the main thread keeps the run loop NSWorkspace needs; it exits when stdin closes. The daemon client restarts it with backoff if it dies (it must run to hear wake). Off macOS, or with `APPLYANT_NATIVE_PATH=off` (the e2e tests, so they never reach the real Keychain), the daemon gets a stub.
- **Keychain**: generic passwords under service `com.applyant`. An existing `secrets.json` is moved in once at start and deleted only after every value is stored; if that fails the daemon stays on the file. The helper is signed with an identifier-only designated requirement: with the default ad-hoc requirement (the binary's hash) every rebuild would ask "allow access?". Checked with two different builds: the second read the first one's item without a prompt.
- **Text**: PDFKit's `page.string` is not strictly better than pdfjs. On the fixture CV it moves one wrapped line up a line; on two of the owner's two-column CVs the two differ by a few lines each way. Sorting PDFKit's lines by position matches pdfjs on the fixture but interleaves columns, so `page.string` stays, per the plan, with pdfjs as the fallback (helper error, or no text layer).
- **Wake**: logged, and a `system.wake` event on the stream. The scheduler's catch-up comes with phase 10.
- **`app/` is a Swift package, not an Xcode project.** `xcodebuild` runs packages (schemes `Applyant`, `applyantd`, `Applyant-Package`), there's no `.pbxproj` to maintain by hand, and connect-swift in 8b is one more package dependency. `ApplyantKit` holds everything testable. `scripts/bundle.sh` assembles the bundle.
- **launchd runs a Mach-O, not a script**: `Contents/MacOS/applyantd` (Swift, in `app/`) execs the bundled Node on `daemon/src/main.ts`, so after the exec launchd's KeepAlive watches the daemon itself. It sets `PLAYWRIGHT_BROWSERS_PATH` to the data dir's `browsers/` and `APPLYANT_INSTALL_BROWSERS=1`, so the daemon fetches the reader's headless shell on first launch (the reader waits for it), and writes stdout/stderr to `~/Library/Logs/Applyant/applyantd.log` (one rotated copy at 10 MB). The embedding model is fetched on first use, as before.
- **SMAppService took the ad-hoc signed app, but not its next build.** The first install registered and ran with no approval prompt. After a rebuild, launchd killed the new launcher (`Launch Constraint Violation`, "spawn failed", EX_CONFIG): SMAppService pins an ad-hoc binary by its hash, and unregister + register didn't refresh that ("needs LWCR update"). Found in the 8b session; since then the agent is a plain `~/Library/LaunchAgents/com.applyant.daemon.plist` bootstrapped with `launchctl` (the planned fallback, now the only path), and the app takes down the old SMAppService agent once. Checked: a rebuilt, reinstalled bundle keeps its daemon, and launchd restarts a killed one (within its 10 s throttle). The agent is `ProcessType Interactive` (browser automation shouldn't be throttled); the app itself stays a login item through `SMAppService.mainApp`.
- **Bundle**: the official Node for the version on PATH, SHA-256 checked against nodejs.org; `daemon/src` plus a hoisted production `node_modules` (flat, no symlinks); other platforms' onnxruntime binaries dropped, and so is the Agent SDK's own `claude` build (~200 MB), so the SDK can't fall back to it. 600 MB installed. Every Mach-O in `node_modules` is signed ad-hoc (9: better-sqlite3, sqlite-vec, onnxruntime, sharp/libvips, @napi-rs/canvas), then Node, the helper, the launcher and the app. No hardened runtime, no entitlements; nothing needed them. The CLI is linked as `~/.local/bin/applyant` (where `claude` lives), not `/usr/local/bin`, which needs root on Apple silicon.
- **`smoke-bundle.sh`** runs the bundle the way launchd does (`env -i` with HOME, USER and `/usr/bin:/bin:/usr/sbin:/sbin`; no SHELL) on a throwaway data dir: `claude` found in `~/.local/bin`, nvm's `codex` through the dscl shell's PATH, both signed in; the helper answers; `ListPostings` answers; a Keychain round trip through the bundled CLI; a clean stop on SIGTERM.

#### Manual Verification

- [ ] Fresh install on the Mac. Log out and back in, and check that the menu bar shows the daemon running. Check that `applyant status` from the bundled CLI prints where `claude` and `codex` were found.
  - Later the same day: the app is an enabled login item (`SMAppService.mainApp.status == .enabled`) and the agent file has `RunAtLoad` + `KeepAlive`, so both start at login; logging out and in wasn't done (it would end this session).
  - 2026-09-28: fresh install through `scripts/bundle.sh`: the daemon ran under launchd from `/Applications` right after the first app launch, and `applyant status` printed `claude ✓ ~/.local/bin/claude (fixed directory) · 2.1.283 · signed in` and `codex ✓ ~/.nvm/versions/node/v22.18.0/bin/codex (login shell's PATH) · codex-cli 0.157.1 · signed in`, native helper ✓, secrets in the keychain. `kill -9` of the daemon: launchd started a new one within a second (`runs = 2`), and the old helper exited with it. Left for the owner: logging out and back in, and looking at the menu bar icon (this session had no screen-recording permission to see it).
- [x] Import the PDF CV through the native path, and check that the Jev key moved into the Keychain.
  - 2026-09-28: the owner's real CV (`~/Downloads/roman_kudin_cv.pdf`, 3 pages) imported through the launchd daemon: the log says `document read · reader: applyant-native · pages: 3`, and the `claude` extractor (spawned under launchd, found in `~/.local/bin`) gave 55 facts in 13 projects (`ai-serv` got 54–63 from the same CV). There was no `secrets.json` on this Mac to move; the Jev key set through the bundled CLI lives in the Keychain (`security find-generic-password -s com.applyant -a jev`), no file was written, and the live Jev test read it from there (9 requests). The move itself is tested against the fake helper.
- [ ] Put the Mac to sleep across a schedule slot. After wake, check that one catch-up run appears.
  - Until phase 10 there are no schedules: after a sleep, `applyant runs show` should list a `system.wake` event ("the Mac woke from sleep"). Not done in this session (it would have put the owner's Mac to sleep). Covered by tests only: the Swift observer forwards `didWakeNotification`, the daemon turns the helper's `wake` into a `system.wake` event.

---

## Phase 8b: The candidate runs the core loop from the Mac app

The SwiftUI app becomes the everyday interface for phases 1–7. `AppStore` is one `@Observable` store fed by `WatchEvents`. It covers the Inbox, posting detail with the score breakdown, and the review screen (answers first, flagged sentences, evidence panel, CV card, Approve), plus actionable notifications. The menu bar gains counters and quick actions. The hand-off check that `xvfb` couldn't show in phase 6 is done here. Remaining sidebar sections show empty states until their phases.

### Change Outline

```diff
 applyant/
 ├── buf.gen.yaml                ~ + connect-swift into app/Generated
 └── app/
     ├── ApplyantApp.swift       ~ main window (NavigationSplitView) + MenuBarExtra counters · quick actions
+    ├── AppStore.swift          # @Observable; reloadAll on every (re)connect
+    ├── Views/Sidebar · Inbox · PostingDetail · ReviewApplication · HandOff
+    └── NotificationDelegate.swift   # Review · Skip · Open actions → RPC
```

### Validation

#### Automated Verification

- [x] `xcodebuild -scheme Applyant-Package -destination 'platform=macOS' test` in `app/` (AppStore reload on reconnect, event application, approve disabled while flags remain): 18 tests, including one against the real daemon

Progress notes (2026-09-28, on the owner's Mac):

- **Client**: `buf.gen.yaml` also runs Buf's hosted `apple/swift` and `connectrpc/swift` plugins into `app/Generated` (pinned to the versions `app/Package.swift` depends on: swift-protobuf 1.38.1, connect-swift 1.2.3); CI checks that output too. The app speaks the Connect protocol with the binary codec; the event stream has its own URLSession without an idle timeout.
- **`AppStore`** (in `ApplyantKit`, so it's tested without SwiftUI) talks to a small `DaemonAPI` protocol over the generated client, so tests use a fake daemon. One change to the TDD's loop: before reloading, it reads the newest stored event id and then watches from it (`after_event_id`), so events between the reload and the subscription aren't lost either. Events refresh the one posting or application they name (GetPosting / GetApplication); task events drive the menu bar's "Working: …" and "Waiting for claude limit · resumes 15:45".
- **Screens**: the PRD's sidebar (Inbox, Ready to review, Preparing, Interested, Skipped, Applied are live; the rest say which phase fills them), the posting (score points per component, ✓/~/✗ requirements with their facts, dealbreakers, Prepare / Review / Interested / Skip… with a reason / Open posting), and the review screen: standard fields folded into "N standard fields ready" with Show all and per-application Change, values that need filling pulled out, the CV card (Preview, base ↔ tailored), each answer with its flagged sentences highlighted and fixed in place (Confirm facts, True as written, Edit…, Write the answer… for a needs-you question), evidence for the selected answer with Confirm on the right, Regenerate…, and Approve, disabled with the blockers as its tooltip. Applied applications show their receipt. CV line edits stay in the CLI (`applications cv edit`).
- **Hand-off**: the card says why and where delivery stopped, "Show the browser window" activates Applyant's own Chrome (found by its `--user-data-dir`), and "Try delivery again" calls SubmitApplication. The hand-off notification's Open does the same.
- **Notifications** come from live events only (never from a reload): ready to review (Review · Skip · Open), needs you, hand-off. The first launch asks for notification permission.
- **Window**: the app stays a menu bar app; the window doesn't open at login (`defaultLaunchBehavior(.suppressed)`, so the package now targets macOS 15) and opens from the menu, a notification, or opening the app again. It takes a Dock icon while open.
- **The launch agent moved off SMAppService** (see 8a's notes).
- **Found by the scripted check and fixed** (see the manual notes below): captchas are handed over only after the step is filled; `MarkSubmitted` RPC · `applications mark-submitted` · "I submitted it" records a hand-off finished by hand (applied, receipt of the prepared values, hand-off closed); confirming facts writes a tailored CV that was skipped for lack of them; a label asking for city and country gets the whole location; `pgrep -f --` for the Chrome window; the review screen's layout; the hand-off tests run on macOS without `DISPLAY`.
- **Checking tools**: `daemon/scripts/demo-board.ts` and `Applyant --script steps.json --out dir` (app/Sources/Applyant/ScriptRunner.swift). Offscreen, the sidebar's selected row renders black (its material isn't drawn into a bitmap); on screen it's the normal highlight.
- **Integration test**: the store against the real daemon on a throwaway data dir (`daemon/src/main.ts`, fake `claude`, no native helper): connect, reload, a posting added from the CLI arrives through WatchEvents alone, then the verify task's events. It runs when Node ≥ 24 and `daemon/node_modules` are there.

#### Manual Verification

- [ ] Go from an Inbox posting through Review to Approve without touching the terminal, timing it for metric #3.
  - 2026-09-28, checked by the agent, not by hand: this session had no screen-recording or accessibility permission, so it drove the installed app with `Applyant --script` (each step calls the store action the button calls, then the window renders itself to a PNG) against the launchd daemon, the owner's real CV and `daemon/scripts/demo-board.ts` (synthetic postings on 127.0.0.1 that log what they receive; nothing went anywhere real). Scores 94 · 96 · 93; applications prepared on their own. Application 1: Inbox → posting → review with 2 blockers → "True as written" on the verifier-flagged sentence → "Confirm all" → Approve → delivered: the board received all 12 values, the PDF and the answer. Application 2: the needs-you question answered with "Write the answer…" → "Confirm all" (which now writes the tailored CV) → Approve → captcha hand-off → "I submitted it" → applied. A live "ready to review" notification from the menu bar app was delivered (checked with `deliveredNotifications`); its Review / Skip / Open buttons weren't pressed. The run found and fixed: the empty-form captcha hand-off, no way to record a hand-off finished by hand, the skipped tailored CV after confirming, "Location (city, country)" getting only the country, the browser-window button never finding Chrome, and a cramped review screen. Screenshots and the demo state are in `~/Library/Application Support/Applyant-check-2026-09-28/`; the live data dir was reset afterwards (models and the reader browser kept, the Jev key stays in the Keychain).
  - Left for the owner: the same path by hand on real postings, timed (the scripted run says nothing about metric #3).
- [ ] Force a hand-off on an owned test board (an unknown required question). Check that the notification opens the restored Chrome window with the form filled, and that you can finish and submit it.
  - 2026-09-28, the demo board's reCAPTCHA form: the hand-off left Applyant's Chrome window open with every field filled (the saved page snapshot lists the values), "Show the browser window" brought that window forward, and "I submitted it" recorded the application as applied. Left for the owner: solving the captcha and pressing submit in that window by hand.

---

## Phase 9: The agent interview fills in what sources can't show

The interview comes before search on purpose. It's what supplies "what I personally built", the team and the impact. Without those, metric #4 is judged against a thin knowledge base, and preparation's "missing fact" stays a dead end. The interview is almost entirely in the daemon. The transcript is Applyant's own, stored in SQLite. Each turn is a fresh agent run seeded with the transcript and the project's facts, and answers become `interview`-origin `confirmed` facts. Preparation now opens an interview question for a missing fact instead of ending in `needs_candidate`, and resumes once it's answered. The app gains one chat view.

### Change Outline

```diff
 daemon/src/domain/knowledge/
+├── interview.ts                # gap finder per project (role · personal contribution · team · impact)
+│                               # turn = fresh run over transcript + facts → question | facts[]
+└── interview-schema.ts         # zod: { question: string | null, facts: [{text, kind, projectId}] }
 daemon/src/domain/applications/prepare.ts
+  ~ missing fact → open interview question (linked to application) · resume prepare on answer
 daemon/src/cli/interview.ts     # `candidate interview` (terminal chat) · `interview list`
 app/Views/Interview             # chat; sidebar badge for open questions
 test/
+├── interview.test.ts           # answer → confirmed fact · same question never asked twice
+└── prepare-missing-fact.test.ts   # prepare pauses on question, resumes to ready_for_review after answer
```

```sql
interview_turns(id, project_id, application_id, role, text, created_at)   -- role: agent | candidate
interview_questions(id, project_id, application_id, text, status)         -- open | answered | dismissed
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `xcodebuild … test` (Mac)

#### Manual Verification

- [ ] Do a full interview on two real projects, then re-prepare the phase-5 application. Check that the answers now cite interview facts about personal contribution.

---

## Phase 10: Search strategies find postings on their own

Postings now arrive without `jobs add`. Strategies are rows with their sources, queries, schedule and state. The scheduler enqueues `search` tasks per active strategy, each tagged with a `run_id`. The generic reader tries a feed first (JSON, RSS, JSON-LD), then the known-ATS-embed detector and that ATS's public list API. Results pass through dedupe: exact keys first, then MinHash over description shingles, with embeddings as the tie-breaker. New postings enter at `found`. The Search screen and `search strategies …` show per-strategy and per-source found/verified/interested counts, with toggles for each.

### Change Outline

A posting missing from a source proves nothing unless that source returned everything. So every reader run reports whether its list is complete, and absence closes a posting only in that case.

```ts
interface ReaderRun {
  listings: Listing[];
  complete: boolean;   // true only when the source gives a full list (feed, ATS list API) AND the run finished
}

on absence of posting P from source S's run:
  if run.complete → mark P closed on S (closed everywhere once no open source remains)
  else            → enqueue verify_posting(P)   // posting_liveness decides; recipes, web search, partial pagination land here
```

```diff
 daemon/src/domain/search/
+├── strategies.ts               # CRUD · pause · schedule · per-strategy stats
+├── sources.ts                  # source registry + enable/disable; disabled ⇒ never queried; completeList per kind
+├── readers/feed.ts             # JSON · RSS · JSON-LD JobPosting (complete)
+├── readers/ats-embed.ts        # detect Greenhouse / Ashby / Lever / Workable embed → token/slug
+├── readers/ats-api.ts          # the four public list APIs, incl. api.eu.lever.co fallback (complete)
+├── readers/boards.ts           # HN Algolia · RemoteOK · WWR · Remotive · Himalayas · Arbeitnow · Jobicy
+├── dedupe.ts                   # canonical URL · ATS id · company+title · MinHash · embedding tie-break
+├── absence.ts                  # the rule above
+└── handlers.ts                 # search task → listings → found postings (+ posting_sources)
 daemon/src/cli/search.ts        # strategies list|add|pause|edit · sources list|off|on · runs show
 app/Views/Search · AgentRuns
 test/
+├── dedupe.test.ts              # same role via board + ATS + career page → one posting, three sources
+├── readers.test.ts             # recorded API/feed responses per reader
+└── absence.test.ts             # complete ATS run → closed · failed/partial run → re-verify, never closed
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `xcodebuild … test` (Mac)

#### Manual Verification

- [ ] Run a day of scheduled searches against the candidate's real preferences. Check that the shortlist has no dead postings (metric #1) and at least half are ones you'd mark interested (metric #2).

---

## Phase 11: The agent discovers new boards and reads them with recipes

This phase adds the Codex provider, role reassignment from the CLI, and the two agent-driven parts of search. `search_planner` (Codex by default) proposes strategies from the profile and runs web searches, including `site:` queries, with its built-in search. The boards it finds join a watch list and are polled directly. Pages with no feed and no known embed get a `ListingRecipe` written once by `reader_builder`. The recipe is checked against the page it was built from, stored with its fixture, and runs on every later poll as plain Playwright. It's rebuilt when an invariant fails. Recipe runs always report `complete: false`, so they never close postings by absence. New strategies appear marked "agent-generated", and weak ones run less often.

### Change Outline

```diff
 daemon/src/
 ├── models/
+│   ├── providers/codex.ts      # @openai/codex-sdk with codexPathOverride; run(prompt, {outputSchema}); limit → pause
+│   └── roles.ts                ~ routing table persisted in SQLite (defaults as seed)
+├── cli/config.ts               # `applyant config roles [list | set <role> <provider[:model]> | reset]`
 ├── domain/search/
+│   ├── planner.ts              # search_planner: propose strategies · web search → candidate boards
+│   ├── watchlist.ts            # boards found by search; polled like any source
+│   ├── recipes/build.ts        # build_recipe task (reader_builder) · verify on same page · store fixture
+│   ├── recipes/run.ts          # locators | textPattern · pagination · invariants · complete: false
+│   └── strategies.ts           ~ interested-rate → run less often (never removed)
 test/
+├── recipes.fixtures.test.ts    # every stored recipe replays against its fixture offline
+├── invariants.test.ts          # count window only after lastCount ≥ 5 · scroll stop after 3 empty
+├── roles-config.test.ts        # set matcher → codex; next score_posting runs on codex
+└── codex-provider.test.ts      # JSONL stream parsing · usage-limit exit 1 → pause_provider
+                                # SDK spawns exactly codexPathOverride (fake `codex` script writes its argv)
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `APPLYANT_LIVE=1 pnpm -C daemon test:live -t "codex|reader_builder"`

#### Manual Verification

- [ ] Let the planner run once and review its proposed strategies and new boards in the Search screen. Then pick one career page that needed a recipe and check its listings against the page.

---

## Phase 12: Company research feeds the score and the answers

Preparing an application, or pressing **Company research**, runs `researcher` (Codex by default) once per company. The result is a sourced `companies` profile with red flags, refreshed after 30 days. Red flags join `score()` as soft components. The writer context gains the company summary for "Why us?" answers, and the review evidence panel shows it. The app gains the Companies section.

### Change Outline

```diff
 daemon/src/domain/
+├── companies/research.ts       # research_company handler · 30-day freshness · findings with URLs
+├── companies/schema.ts         # product · funding · size · founders · stack · news · layoffs · reviews · red_flags[]
 ├── scoring/score.ts            ~ + 'company' component from red flags (soft)
 └── applications/writer-context.ts   ~ + company summary
 app/Views/Companies · PostingDetail ~ research button · ReviewApplication ~ company summary
 test/
+└── company-score.test.ts       # red flag lowers score proportionally, never to zero
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `xcodebuild … test` (Mac)

#### Manual Verification

- [ ] Research three companies you know and check that the findings and red flags are accurate and sourced.

---

## Phase 13: The mailbox tracks status, reads security codes and sends email applications

One `Mailbox` adapter now serves three uses. Google accounts go through the Gmail API (one loopback + PKCE consent covering Gmail, Calendar and Drive, using the owner's "Desktop app" OAuth client). Everything else goes through IMAP IDLE with SMTP. Incoming mail is classified on-device through `applyant-native` (Foundation Models). It's matched to an application, which moves to rejected, interview or offer. Emails that can't be classified go to a "Which application is this?" queue. Delivery reads Greenhouse-style security codes from the mailbox. The email channel sends prepared applications with the tailored CV. Interview invites become Google Calendar events.

### Change Outline

```diff
 daemon/src/
 ├── integrations/
+│   ├── google-oauth.ts         # loopback 127.0.0.1 + PKCE · tokens via Secrets
+│   ├── gmail.ts · imap.ts · smtp.ts   # Mailbox { sync(cursor), send(msg) }
+│   └── gcal.ts                 # interview events linked to application + company
+├── channels/email.ts           # Channel: read = address + message parts · deliver = send with CV
+├── domain/applications/mail-status.ts   # classify → match → status · unsure → ask queue
 ├── domain/applications/deliver.ts      ~ security-code step reads mailbox
 └── native/client.ts            ~ classify_email
 native/ClassifyEmail.swift      # Foundation Models; unavailable/low confidence → "unknown"
 app/Views/Applications (Applied · Interviews · Offers) · WhichApplication
 test/
+├── mail-status.test.ts         # fixture emails (fake classifier) → status moves; low confidence → queue
+├── security-code.test.ts       # fixture form asks code → read from fake mailbox → confirmed
+└── email-channel.test.ts       # SMTP to a local test server; receipt stores message + CV hash
```

`email_classify` never falls back to a cloud model unless Settings (or `applyant config roles`) says so. The routing table enforces this with no special case.

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `swift test --package-path native` (Mac; the classify_email contract is skipped when Apple Intelligence is off)

#### Manual Verification

- [ ] Connect the real mailbox and check that a week of past replies sets the right statuses. Send one email application to yourself and check it.

---

## Phase 14: Captchas, logged-in sites, LinkedIn and Xing

When delivery meets a captcha, CapMonster is tried before any hand-off. Sites that need an account get a plain, unautomated Chrome window on Applyant's profile for a one-time sign-in, with logins kept in `Secrets`. LinkedIn and Xing become both sources (a search-page recipe run under the session) and channels (Easy Apply and Xing apply through the ordinary form engine). Guardrails serialise and pace them: one tab, daily caps, randomised delays, and a pause whenever the candidate is active in that profile. Any platform challenge pauses the platform and hands off, and never goes to CapMonster.

### Change Outline

```diff
 daemon/src/
+├── integrations/capmonster.ts  # createTask / getTaskResult · reCAPTCHA v2/v3/Ent · hCaptcha · Turnstile
 ├── browser/
+│   ├── captcha.ts              # detect type + sitekey → solve → inject token + callback
+│   ├── login-window.ts         # open profile in Chrome without automation for sign-in
+│   └── guardrails.ts           # per-platform serial lane · daily caps · pacing · challenge → pause + handoff
+├── domain/search/readers/linkedin.ts · xing.ts   # recipe-backed search pages under session (complete: false)
 └── domain/applications/deliver.ts   ~ captcha step before handoff · prefer original company form
 app/Views/Settings ~ captcha key · platform caps · sign-in buttons
 test/
+├── captcha.test.ts             # fixture pages per captcha type → fake solver → token injected
+└── guardrails.test.ts          # second LinkedIn task waits · challenge fixture → platform paused, never solved
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && xvfb-run pnpm -C daemon test`

#### Manual Verification

- [ ] Submit on a Workable board with Turnstile on (a fresh trial if the phase-4 one has expired), and check the solve goes through CapMonster.
- [ ] On the Mac, sign Applyant's profile into its own LinkedIn login once. Then run one paced search and one Easy Apply on a posting the candidate actually wants.

---

## Phase 15: Telegram as a source and a channel

Public channels are read through the `t.me/s/<channel>` preview with a `textPattern` recipe, with no login. The `extractor` turns each post into a posting (role, company, salary, location, contact). Connecting the candidate's own account (GramJS, session in `Secrets`) adds private channels and the Telegram channel for delivery. That channel sends the prepared message and CV to the contact. The planner suggests channels to follow.

### Change Outline

```diff
 daemon/src/
+├── integrations/gramjs.ts      # login flow · session via Secrets · read · send
+├── domain/search/readers/telegram.ts   # preview recipe · MTProto for private channels (complete: false)
+└── channels/telegram.ts        # Channel: read = contact + message parts · deliver = send
 app/Views/Settings ~ Telegram connect · Search ~ channel list
 test/
+└── telegram.test.ts            # recorded preview HTML → postings · fake client → delivery receipt
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`

#### Manual Verification

- [ ] Follow two real job channels and check the resulting postings. Send one Telegram application to a test contact.

---

## Phase 16: Onboarding, Google Drive and the Share extension

This phase closes out the candidate's first-launch experience and the remaining entry points. The four-step setup is built on `GetSetupStatus` from 8a:

1. **Connections:** `claude` and `codex` paths and sign-in, the Jev key, GitHub, the mailbox, Calendar.
2. **Import.**
3. **Preferences:** pre-filled from the CV. Search starts when this step is done.
4. **Interview:** the phase-9 chat, with a "Later" option.

Google Drive joins the source kinds through the phase-13 consent. The sandboxed Share extension sends a URL into the same `found` flow.

### Change Outline

```diff
 daemon/src/
+├── domain/knowledge/sources/drive.ts   # drive.readonly · files.export → text
 └── rpc/setup.ts                ~ + jev · github · mailbox · calendar in SetupStatus · prefs-from-CV draft
 app/
+├── Onboarding/                 # Connections · Import · Preferences · Interview (Later)
+└── ShareExtension/             # network.client entitlement · AddPosting via App Group token file
 test/
+└── drive.test.ts               # recorded export responses → facts with drive evidence
```

### Validation

#### Automated Verification

- [ ] `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test`
- [ ] `xcodebuild … test` (Mac; onboarding state machine, Share extension token read)

#### Manual Verification

- [ ] Run a clean install on a fresh macOS user through all four setup steps. Check that search starts after Preferences.
- [ ] Share a posting from Safari and follow it to Ready to review.
- [ ] Over two real weeks, record all four PRD metrics.
