# Contributing to GTE Agent

GTE Agent is a pre-MVP retrofit of an OpenCode fork into an agentic trading runtime. Internal planning docs live in `docs/` (start with `docs/overview.md`); the old OpenCode product docs and surfaces have been removed.

## Development

Requirements: Bun 1.3+

```bash
bun install

# Launch the TUI (runs the canonical server in-process via a worker)
bun run --cwd packages/tui src/index.ts

# Headless API server
bun run --cwd packages/cli src/index.ts serve --port 4096
```

`gta` is the user-facing TUI command (bin of `packages/tui`); `gte-agent` (`packages/cli`) is the daemon/scripting CLI.

## Core pieces

- `packages/core`: canonical Effect-native runtime — sessions, durable events, typed tools, permissions, GTE auth stub, read-only GTE data layer, local SQLite persistence.
- `packages/server`: typed HTTP API over `packages/core`.
- `packages/tui`: the `gta` TUI (OpenTUI + Solid).
- `packages/cli`: daemon/scripting CLI (`gte-agent serve`).
- `packages/sdk/js`: generated JS SDK. Regenerate with `bun run --cwd packages/sdk/js build` after API changes.
- `packages/gte-ts`: vendored read-only GTE data SDK — verbatim upstream copy, do not edit locally (see `packages/gte-ts/VENDORED.md`; re-sync with `bun run script/sync-gte-ts.ts`).
- `packages/llm`, `packages/plugin`, support packages: LLM abstraction and extension substrate.

## Checks

Run before pushing (the pre-push hook runs typecheck and the import audit):

```bash
bun run typecheck     # root, via turbo
bun run lint          # oxlint
bun run audit:gte     # read-only boundary gate: fails on gte-ts mutation/signing imports
bun test              # per package — run from package dirs, not the repo root
```

The read-only boundary is non-negotiable in Phase 1: active code may import only `createGteDataClient` and read/stream types from `gte-ts`. Never import `createGteOrderClient`, signer adapters, or order/account write surfaces.

## Style and commits

Follow the style guide in [AGENTS.md](./AGENTS.md). Use conventional commit messages and PR titles (`type(scope): summary`), e.g. `feat(tui): add order book panel`, `fix(core): normalize tracked address`.
