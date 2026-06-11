# Milestone 4: opencode TUI pattern notes

Record of which patterns from the quarantined `packages/opencode` were mined for the
`packages/tui` (`gta`) implementation, which were rejected, and the status of the
`packages/opencode` removal checklist. Nothing was imported from `packages/opencode`;
every adopted pattern was rewritten against the canonical runtime.

## Mined (rewritten, not copied)

- **Worker-hosted server + in-process channel** (`src/cli/cmd/tui/thread.ts`, `worker.ts`):
  `gta` spawns a Bun `Worker` that hosts the canonical server via
  `webHandler()` from `@gte-agent/server/routes`, exposed to the TUI as a
  fetch-compatible function against the virtual origin `http://gte-agent.internal`.
  Rewritten in `packages/tui/src/server/{protocol,worker,bridge}.ts`.
  Key deviation: opencode's RPC fetch buffered the whole response body as text
  (`await response.text()`), which cannot carry SSE; the new bridge streams
  response bodies chunk-by-chunk over `postMessage` and propagates cancellation
  (aborting the bridged `Response` body aborts the request inside the worker).
  This removes the need for opencode's separate `global.event` RPC event channel —
  the canonical per-session SSE route flows through the same fetch bridge.
- **Explicit network opt-in** (`thread.ts` `--port/--hostname` handling): default is
  in-process only (no TCP); `--listen`/`--port`/`--hostname` ask the worker to start a
  real `Bun.serve` listener. Rewritten as a `listen` bridge message.
- **Clean shutdown on TUI exit** (`thread.ts` `stop()` with timeout + `worker.terminate()`):
  rewritten as `bridge.shutdown()` (abort in-flight requests, stop listener, dispose the
  server layer, terminate the worker, 5s timeout).
- **Renderer bootstrap** (`app.tsx` `createCliRenderer` config): kept
  `exitOnCtrlC: false`, `targetFps: 60`, explicit destroy-on-exit; dropped mouse/kitty/
  console/theme-mode plumbing.
- **TUI lifecycle promise** (`app.tsx` `tui()` handle): simplified to a single `done`
  promise resolved by `onExit`, signal handlers (SIGINT/SIGTERM/SIGHUP), and renderer
  `destroy` event.
- **Test harness patterns** (`test/cli/tui/app-lifecycle.test.ts`, `test/fixture/tui-sdk.ts`):
  in-memory rendering via `@opentui/core/testing` (`testRender`, `waitForFrame`,
  `mockInput`) and a mock-fetch fixture per route. The fixture was rewritten for the
  canonical routes (`/api/health`, `/api/session`, `/api/session/:id/{message,prompt,event}`)
  and the SSE stream is a real `ReadableStream` SSE body instead of opencode's separate
  mock event-source object, so the production SSE parser is exercised in component tests.
- **Per-package bunfig with solid preload** (`packages/opencode/bunfig.toml`): adopted for
  `bun test`/`bun run` inside `packages/tui`. Additionally `gta`'s entry registers
  `ensureSolidTransformPlugin()` from `@opentui/solid/bun-plugin` at runtime before
  dynamically importing the JSX app, so the bin works from any cwd without a preload.
- **tsconfig JSX settings** (`packages/opencode/tsconfig.json`): `jsx: "preserve"`,
  `jsxImportSource: "@opentui/solid"`.
- **CLI subprocess smoke test** (`cli-process` style): minimal `Bun.spawn` test of
  `gta --help` / bad-flag exit codes in `packages/tui/test/cli.test.ts`.

## Rejected

- **opencode session/sync runtime coupling** (`SyncProvider`, `SyncProviderV2`,
  `SDKProvider`, project/provider/config providers): tied to the legacy session loop,
  share/sync, and `/config`-style routes that do not exist on the canonical server.
  Replaced by a small typed wrapper over `@gte-agent/sdk` plus one SSE subscriber.
- **Global event bus RPC channel** (`GlobalBus` → `Rpc.emit("global.event")`): the
  canonical runtime exposes per-session durable SSE with cursors; a process-global event
  channel would bypass replay semantics.
- **JSON-string RPC protocol** (`util/rpc.ts` `JSON.parse(evt.data)`): replaced with
  structured-clone messages so binary chunks (`Uint8Array`) stream without re-encoding.
- **Coding-specific UI**: file tree, diff viewer, editor context, shell panes, plugin
  runtime/slots, command palette, keymap config system, themes, frecency, prompt stash,
  audio, attention, win32 ctrl-c guards, upgrade checks, heap snapshots. Out of scope for
  the GTE Agent TUI; the M4 surface is sessions, transcript, prompt, status, and the
  reserved data workspace.
- **`validate-session.ts`, `--continue`/`--fork` flags**: legacy session semantics;
  session selection happens in the TUI session list for M4.
- **opencode dialog/route system** (`RouteProvider`, dialog stack): overkill for two
  screens; a single store field switches between session list and session view.

## `packages/opencode` removal checklist (completed in M6)

- [x] `gta` TUI exists on the canonical runtime (`packages/tui`, OpenTUI + Solid,
      worker-hosted `@gte-agent/server`).
- [x] No active imports, route mounts, package scripts, build scripts, tests, or SDK
      generation paths in `packages/tui` (or other active workspaces) depend on
      `packages/opencode` (it remained excluded from root workspaces; the canonical SDK
      generation path is `packages/sdk/js/script/build.ts`, which generates from
      `@gte-agent/server/api`).
- [x] Useful TUI/test patterns copied (rewritten) or deliberately rejected — this document.
- [x] Docs no longer point future implementation work at `packages/opencode` except as
      historical context (remaining mentions in milestone plans and `docs/overview.md`
      describe the quarantine/removal policy itself and are historical after deletion;
      the M6 closeout updates `docs/overview.md`).
- [x] The active TUI has no legacy share, sync, workspace, filesystem, shell, or
      coding-tool coupling.
- [x] Final deletion of `packages/opencode` — deleted 2026-06-11 during Milestone 6
      acceptance. All harness patterns were extracted before deletion:
      `httpapi-exercise` route DSL → `packages/server/test/httpapi-exercise`,
      `@opentui/core/testing` component testing → `packages/tui/test`,
      worker-hosted server pattern → `packages/tui/src/server`,
      `cli-process` subprocess harness → extracted as `Bun.spawn` smoke tests of
      `gta --help` / bad-flag exit codes in `packages/tui/test/cli.test.ts`.
      Dangling references cleaned with the deletion: the dead legacy generation step in
      `script/generate.ts` and the `packages/opencode` exclusion entry in
      `script/audit-gte-imports.ts` (+ its test fixture).

### Notes for the M6 closeout agent

Stale post-deletion mentions left for closeout (none are functional dependencies):

- `docs/overview.md` still describes `packages/opencode` as existing on disk
  (lines around 43, 49, 69, 174–176, 241) — update to past tense / deleted.
- `AGENTS.md` uses `packages/opencode` as the example package dir for running
  tests/typecheck and `@opencode-ai/core` in an import example.
- `CONTRIBUTING.md` says `bun dev` runs in `packages/opencode` and cites
  `packages/opencode/src/server/server.ts` for SDK regeneration.
- `script/version.ts` imports `@opencode-ai/script`, which only resolves via a
  stale `node_modules/@opencode-ai/script` symlink to `packages/script` (now
  `@gte-agent/script`); the release script is not wired into CI here.
- `bun.lock` still records the root workspace name as `opencode`.
