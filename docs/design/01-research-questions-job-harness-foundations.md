---
type: research-questions
---

# Research Questions

1. What currently exists in the `applyant` repository (files, commits, `.gitignore`, any tooling config), and what does the host machine `ai-serv` provide as documented in `~/ops/README.md` — OS version, CPU/RAM/disk, installed runtimes (Python version, `uv`, Node, Docker + Compose), absence/presence of a native PostgreSQL, headless (no GUI) constraints, the systemd **user** service conventions (linger, `~/.config/systemd/user/`, PATH via `environment.d`), and how provider logins (`claude`, `codex`, `gh`) are handled on this machine?

2. How does the Claude Code CLI (`~/.local/bin/claude`) operate non-interactively: what do the `-p/--print` mode and `--output-format json|stream-json` emit (fields for result, session id, cost/usage, errors), how are structured outputs / JSON schemas, system prompts, allowed/disallowed tools, permission modes, MCP config, working directory, and session resume/continue controlled from the command line, what exit codes and failure modes exist (rate limits, auth expiry, timeouts), and how does authentication via a Claude subscription differ from API-key auth in terms of limits and concurrency? How does the Claude Agent SDK for Python relate to the CLI (does it wrap the same binary, what does it expose)?

3. How does the OpenAI Codex CLI (`@openai/codex`, installed globally via npm) run non-interactively via `codex exec`: what are its JSON/JSONL event output format, output-schema / last-message options, sandbox and approval-policy settings, model selection, session resume, config file (`~/.codex/config.toml`) and profiles, and how does ChatGPT-subscription login affect usage limits and parallel invocations?

4. What is Jev (TypeSafe AI's "System One" decision model) and how is it used: what SDK/API does it expose (Python package, HTTP API), how are decisions/choice sets declared (Pydantic types, closed enums, element indices), what inputs does it accept (e.g., numbered DOM element lists, text), what does a response look like (choice, probabilities/confidence), what are its pricing, latency, rate limits, auth model, and documented limitations? Starting points: https://www.langchain.com/blog/building-a-harness-with-jev, https://dev.to/aitejiu/benchmarking-jev-what-a-decision-model-can-and-cant-do-in-an-agent-harness-20po, https://github.com/cobanov/awesome-jev.

5. What public job-posting APIs and page structures do the major ATS platforms expose — Greenhouse (Job Board API, `boards.greenhouse.io` / `job-boards.greenhouse.io`), Lever (Postings API, `jobs.lever.co`), Ashby (`jobs.ashbyhq.com`, posting API), Workable (`apply.workable.com` widget/API)? For each: endpoint shapes, returned fields (posting ID, title, location, remote/workplace type, compensation, description, apply URL, published/updated dates), how a closed/archived posting behaves (404, redirect, flag), how application forms and custom questions are represented (e.g., Greenhouse `?questions=true`), file upload fields, and any captcha/anti-bot measures on apply pages. Additionally, how is schema.org `JobPosting` JSON-LD used on company career pages (fields like `validThrough`, `jobLocationType`, `baseSalary`, `directApply`)?

6. What programmatic web-search options exist for discovering postings with operator queries like `site:jobs.ashbyhq.com "AI Engineer" Europe` (e.g., Brave Search API, Google Programmable Search, SerpAPI, Exa, Tavily, Bing successors) — which support `site:` and quoted operators, what do results contain, and what are their pricing, quotas and ToS constraints? Also, what specialized/startup job boards (e.g., Wellfound, Work at a Startup, Remote EU boards) offer RSS feeds or APIs?

7. How does Playwright for Python run on a headless Ubuntu server: installing browsers and system deps (`playwright install --with-deps`) on Ubuntu 26.04, async API usage under `asyncio`, persistent browser contexts/profiles, file uploads (`set_input_files`), accessibility/ARIA snapshots and locator APIs (`get_by_role`, `get_by_label`, `aria_snapshot`) useful for enumerating form fields, handling iframes (ATS forms embedded in career pages), and typical memory footprint per browser/context on a ~7 GB RAM machine?

8. How do PostgreSQL + pgvector + full-text search fit together: current pgvector version and index types (HNSW, IVFFlat), distance operators, the `pgvector/pgvector` Docker image, combining `tsvector` FTS with vector similarity (hybrid ranking, e.g., reciprocal rank fusion) in plain SQL, Python async drivers (`asyncpg`, `psycopg` 3) and their pgvector adapters, and what embedding-model options exist (API-hosted vs local models runnable on CPU) with their dimensions? Also, what Postgres-backed job/task queue patterns and libraries exist for Python asyncio (e.g., `SELECT ... FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`, Procrastinate) and how they handle retries, timeouts and concurrency?

9. What does the GitHub API (REST and GraphQL) and `gh` CLI (logged in as `romirom11` via HTTPS) expose for extracting repository information — README, tree/structure, languages, commits (with author filtering), PRs, issues, releases — what are authenticated rate limits, and what are the trade-offs between API access and a local `git clone` (shallow/partial clone) for code-level analysis? Similarly, how can Google Drive files and arbitrary URLs/PDFs be fetched and converted to text from Python (Drive API auth for a personal account, PDF text extraction libraries)?

## Key Context Pointers

- Links:
  - https://www.langchain.com/blog/building-a-harness-with-jev
  - https://www.sitepoint.com/build-safer-ai-agent-harness-jev-langchain/
  - https://dev.to/aitejiu/benchmarking-jev-what-a-decision-model-can-and-cant-do-in-an-agent-harness-20po
  - https://github.com/cobanov/awesome-jev
  - https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md (host remote-access convention)
- Repositories: `applyant` (this repo, `~/Developer/applyant`; currently only `README.md` and `.gitignore`)
- Libraries / dependencies (named in the task spec): Python, FastAPI (or a lightweight RPC layer), asyncio, PostgreSQL, pgvector, Playwright, Claude Code CLI, Codex CLI, Jev, GitHub API / git. Spec explicitly excludes LangChain/LangGraph as the orchestration layer.
- Job sources named in the spec: Greenhouse, Lever, Ashby, Workable, company career pages, search engines, specialized/startup job boards, RSS / API
- Filepaths:
  - `.humanlayer/tasks/local-job-search-agent-harness-system-2vuidu/task.md` (full project spec, Ukrainian)
  - `~/ops/README.md`, `~/ops/log.md` (host setup; must be updated after system-level changes)
  - `~/.local/bin/claude`, `~/.npm-global/bin/codex`, `~/.local/bin/uv`
  - `~/.config/systemd/user/` (user service convention)
