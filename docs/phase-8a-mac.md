# Handoff: Phase 8a on the Mac

Phases 1–7 are done on `ai-serv` and live on `main` (git@github.com:romirom11/applyant.git). Phase 8a is the first phase that has to run in an agent session **on the owner's Mac**: Swift, `SMAppService`, launchd and the Keychain don't exist on the Linux box.

**Applyant is for the owner's own Mac only, with no distribution.** So there's no Apple Developer Program, no Developer ID certificate and no notarisation. The bundle is signed **ad-hoc** (`codesign --force --sign -`). A locally built app isn't quarantined, so Gatekeeper doesn't ask for notarisation. Arm64 still needs every Mach-O (Node, the helper, each `*.node`) signed, and ad-hoc is enough for that.

The full design is in `docs/design/` (see its README): the PRD, the TDD, the research it rests on, and the plan (`05-structure-outline-applyant-harness.md`, the phase list with progress notes). Read the TDD's parts on the process layout, packaging and `applyant-native` before starting. This note adds what the plan doesn't know yet and the owner's decisions since. Delete it once 8a is done.

## Before the session: what only the owner can do

| What | Why | Check |
|---|---|---|
| Xcode (full app, not only Command Line Tools), opened once to accept the licence | `swift test`, `xcodebuild`, signing | `xcodebuild -version` |
| Node 24 and pnpm 12 (the `packageManager` in `daemon/package.json`) | building the bundle, running daemon tests | `node --version` → v24.x |
| `claude` CLI installed and signed in (`codex` optional) | `GetSetupStatus` has to find them | `claude --version` |
| Google Chrome | phase 6 delivery uses branded Chrome | `/Applications/Google Chrome.app` |
| A clone of the repo on `main` | | `git clone git@github.com:romirom11/applyant.git` |

No Apple Developer account is needed. Nothing secret goes into the repo.

## The session prompt (paste into a new Claude Code session in the repo on the Mac)

> Read docs/phase-8a-mac.md and implement Phase 8a of Applyant as it describes. Work on `main` directly: commit and push each finished step yourself (it's a greenfield project for my own use; no PRs). Keep `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test` green (Linux CI runs it on every push; macOS has no CI, so `swift test` and `xcodebuild test` run locally). Ask me before changing my login items or keychain beyond Applyant's own entries.

## Phase 8a spec (from the plan)

Packaging only: no views yet. The result is an ad-hoc signed `Applyant.app` in `/Applications` that:

- registers the launch agent `com.applyant.daemon` through `SMAppService` (`KeepAlive`: launchd restarts it after a crash), and itself as a login item, on first launch; there is no separate installer. With an ad-hoc signature, macOS may refuse `SMAppService` or keep asking for approval in System Settings → Login Items. If it does, fall back to writing `~/Library/LaunchAgents/com.applyant.daemon.plist` (pointing at the bundled Node) and `launchctl bootstrap gui/$UID …`, done by the app on first launch. Either way the result must be the same: the daemon runs at login and restarts after a crash;
- starts `applyantd` from the bundled Node;
- talks to `applyant-native` (the Swift helper, a child process of the daemon speaking JSON lines);
- stores secrets in the Keychain (through the helper);
- ships a CLI that works from the bundle (`Resources/bin/applyant`, a launcher on the same bundled Node; symlinked onto `PATH`);
- shows a menu bar item with daemon status only.

A launchd agent doesn't inherit the shell `PATH`, so the daemon looks for `claude` and `codex` itself, at explicit paths, and passes the resolved path to the SDKs. The new `GetSetupStatus` RPC reports where each was found, or that it's missing and why. Build the lookup order and the status shape first: the menu bar, `applyant status` and onboarding (phase 16) all read them.

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
+│   ├── bundle.sh               # node + daemon + helper → Applyant.app; ad-hoc codesign every Mach-O, then the app; install to /Applications
+│   └── smoke-bundle.sh         # launch bundled daemon · bundled CLI → GetSetupStatus + ListPostings
 └── daemon/src/
+    ├── native/client.ts        # spawns applyant-native; request/response + events; Linux stub = "unavailable"
+    ├── secrets/keychain-backend.ts   # via native; chosen on darwin, file backend elsewhere
+    ├── models/cli-paths.ts     # resolve claude · codex
+    ├── rpc/setup.ts            # GetSetupStatus
+    ├── domain/knowledge/text/extract.ts   ~ darwin → native.extract_text; pdfjs-dist stays as fallback
+    └── queue/scheduler.ts      ~ wake event → run each missed schedule once
```

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

Bundle layout (from the TDD):

```text
Applyant.app/Contents/
├── MacOS/Applyant                              # SwiftUI app
├── Resources/
│   ├── node/bin/node                           # official Node, darwin-arm64
│   ├── daemon/                                 # the daemon + production node_modules
│   │                                           #   every *.node binary signed (ad-hoc)
│   └── bin/applyant                            # CLI launcher: exec node … "$@"
├── Helpers/applyant-native                     # Swift helper
└── Library/LaunchAgents/com.applyant.daemon.plist

~/Library/Application Support/Applyant/         # already the daemon's darwin default (config.ts)
├── applyant.db · files/ · repos/ · browser/
├── browsers/    # PLAYWRIGHT_BROWSERS_PATH: headless shell, fetched on first launch
└── models/      # embeddinggemma, fetched on first launch
```

## What the plan doesn't know yet (read before starting)

- **The daemon runs `.ts` directly.** Node ≥ 24 strips types, so there's no build step: `package.json` starts `node src/main.ts` and `node src/cli/index.ts`. The bundle can ship `daemon/src` + production `node_modules` as they are, rather than "compiled JS" as the TDD assumed. Imports use `.ts` extensions (`rewriteRelativeImportExtensions`).
- **Native modules to sign (ad-hoc):** `better-sqlite3`, `sqlite-vec` and `onnxruntime-node` (via `@huggingface/transformers`), plus whatever Playwright/Patchright ship. Sign every `*.node` and `*.dylib` inside `node_modules`, then Node, the helper, and the app last. Without notarisation there's no need for the hardened runtime or JIT entitlements; don't add them unless something fails without them.
- **There is no scheduler yet.** `queue/scheduler.ts` arrives with search in phase 10. In 8a the helper forwards `wake`, and the daemon receives it (log it, and emit it on the EventBus); "run each missed schedule once" lands with phase 10.
- **There is no codex provider yet.** Only `models/providers/claude.ts` exists. It already resolves `claude` as `$APPLYANT_CLAUDE_PATH` → `PATH` → `~/.local/bin/claude`; `cli-paths.ts` replaces that with the full lookup above. For codex, 8a only resolves and reports it in `GetSetupStatus`.
- **Secrets** go through the `Secrets` interface (`daemon/src/secrets/secrets.ts`); `file-backend.ts` stays the Linux one. On darwin, move an existing `secrets.json` (the Jev key) into the Keychain once.
- **Text extraction:** `domain/knowledge/text/extract.ts` has a `TextExtractor` interface; on darwin, ask the helper first and keep pdfjs as the fallback.
- **`Deps`** (`daemon/src/deps.ts`) is where new services go; `main.ts` is the composition root. Handlers never write the DB directly: they return an Outcome whose commit the worker applies.
- **Linux must stay green:** the native client is a stub on Linux ("unavailable"), and `cli-paths.test.ts` runs on Linux over a fake `HOME`. It checks the lookup order, that the shell probe runs once however many tasks resolve, the fallbacks when `SHELL` is unset, empty or `/bin/sh` (the `dscl` shell, then `/bin/zsh`), and that profile noise before the marker is ignored.
- **Proto changes:** edit `proto/applyant/v1/applyant.proto`, then `daemon/node_modules/.bin/buf lint && daemon/node_modules/.bin/buf generate` (CI fails if `daemon/src/gen` is stale). 8b adds connect-swift generation; 8a doesn't need it (the menu bar can call `GetSetupStatus` through the bundled CLI or a small HTTP call).
- **Pushing:** the owner's `gh` token lacks the `workflow` scope, so pushing over HTTPS fails whenever `.github/workflows/` changes. Push over SSH.

## Done when

Automated:

- `pnpm -C daemon typecheck && pnpm -C daemon lint && pnpm -C daemon test` still green (Linux CI)
- `swift test --package-path native`
- `scripts/bundle.sh && codesign --verify --deep --strict /Applications/Applyant.app && scripts/smoke-bundle.sh`

Manual:

- Fresh install on the Mac: log out and back in, and the menu bar shows the daemon running. Kill the daemon: launchd brings it back. `applyant status` from the bundled CLI prints where `claude` and `codex` were found.
- Import the PDF CV through the native path; the Jev key has moved into the Keychain.
- Put the Mac to sleep and wake it: the daemon logs the wake event (the catch-up run itself comes with phase 10's scheduler).

When it's done: tick 8a's boxes in `docs/design/05-structure-outline-applyant-harness.md` and add its progress notes there (what was built differently, what was checked by hand), in the same commit as the work.
