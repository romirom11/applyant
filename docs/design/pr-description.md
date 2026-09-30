[HumanLayer Task](https://app.humanlayer.com/tasks/01a0df5b-7868-701c-8b7e-8454fcd23c06?deep=true)

## Why the change

This adds the first working version of Applyant, a local daemon plus CLI that turns a job posting URL into a verified, scored, evidence-backed application and, only after the candidate approves it, submits it through the real web form.

## Special things to note

- **Submission is guarded twice.** Reading a form (`browser/form-read.ts`) blocks every non-GET request and never presses submit or uploads a file. Delivery only starts after `applications approve`, and approve is refused while a required value is missing, a sentence is flagged, or a cited fact is unconfirmed (`domain/applications/review.ts`).
- **Plan deviations:** there were no owned ATS trial boards, so form fixtures are read-only recordings of public forms (Greenhouse, Ashby, Lever, Workable) plus synthetic local pages. Repeatable groups (Education, etc.) always hand off to the candidate during delivery instead of being filled. Commits from the candidate's own AI coding agents in their repos count as the candidate's work (`domain/knowledge/authorship.ts`).
- **Tests:** the headed delivery test needs Google Chrome and `xvfb` and skips when there is no display. Live tests call the real `claude` CLI and Jev and only run with `APPLYANT_LIVE=1`. CI runs buf lint, a generated-code check, typecheck, lint and the offline suite.

## Change outline

The whole repo apart from the README is new. `proto/` is the only contract between the daemon and its clients. The CLI (and later the macOS app) holds no business logic.

```text
proto/applyant/v1/applyant.proto   # Connect API: postings, prefs, candidate, applications, events, secrets
daemon/src/
├── main.ts          # composition root: DB, worker, browsers, MCP hub, Connect server
├── queue/           # one lease-based task queue; handlers never hold a transaction
├── db/              # SQLite (WAL, FTS5, sqlite-vec) via drizzle; migrations 0000–0008
├── domain/
│   ├── search/        # add a URL, canonicalise, verify it is a live posting with a real apply target
│   ├── knowledge/     # CV / URL / file / GitHub sources → facts with evidence, hybrid retrieval
│   ├── scoring/       # extract requirements, match against facts, pure score() over prefs
│   └── applications/  # read form, prepare, number + claim checks, review gate, deliver, receipts
├── browser/         # snapshot, form engine (read + deliver), headless reader pool, headed Chrome profile
├── channels/        # web-form delivery channel
├── models/          # role → provider routing (claude CLI, Jev), structured-output schemas
├── mcp/             # local MCP tools: knowledge lookups for the writer, 5 browser tools for form_agent
├── rpc/             # Connect handlers, mapping to proto
├── cli/             # `applyant` commands: jobs, candidate, prefs, applications, handoff
└── secrets/         # 0600 file backend behind a Secrets interface
```

A posting moves through queue tasks. Each handler returns an outcome, and the worker commits it and enqueues the next task:

```text
jobs add <url>
  verify_posting                       # live page? open posting? apply leads to a real form?
    score_posting                      # extractor → matcher → score(prefs) = 0–100 with ✓/~/✗ reasons
      if score ≥ threshold and no dealbreaker, or the candidate marked it interested
        prepare_application            # needs read_form done first
    read_form                          # every step, field, option, conditional branch (read-only)

prepare_application
  standard fields  ← profile (or per-application override); missing → needs_candidate
  custom questions ← application_writer (opus), each sentence cites facts
  each sentence    → number/date check (no model) → claim_verifier (haiku)
  → ready_for_review | needs_candidate

applications approve                   # refused while anything is missing, flagged or unconfirmed
  deliver_application → WebFormChannel
    fill each step deterministically; form_agent (sonnet) only for controls it can't operate
    upload base CV, press submit, wait for confirmation
    → applied + receipt                # every value and its source, CV hash, final URL, confirmation text
    | captcha / missing value / stuck step → hand-off: window restored, stays approved, `handoff show`
```

Knowledge is stored as facts, each with evidence and a confirmation status. Answers can only rely on facts the candidate has confirmed:

```text
sources ─sync_source─▶ facts (unconfirmed | confirmed | rejected) ──▶ evidence (file, commit, URL…)
                          │
                          ├─ facts_fts (FTS5) ─┐
                          └─ facts_vec (EmbeddingGemma) ─┴─▶ hybrid retrieve() for matcher and writer

applications ─▶ field_values (source: profile | override | answer | file | rule | none)
             ─▶ answers ─▶ answer_sentences (cited fact ids, check results)
             ─▶ receipts
```
