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

Schema changes: edit `daemon/src/db/schema.ts`, then `pnpm -C daemon db:generate --name <what>`
(never `drizzle-kit push`).
