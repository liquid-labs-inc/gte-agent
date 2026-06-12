# Milestone 4: `gta` TUI

This document is the source-of-truth plan for Milestone 4 of the GTE Agent retrofit.

Milestone 4 pulls the TUI carve-out into Phase 1. Its goal is to make `gta` the user-facing terminal interface for the canonical GTE Agent runtime. It should not implement trading data tools, real GTE auth, trading execution, production persistence, or a full trading workflow.

## Goal

Create a minimal GTE Agent TUI launched through `gta`.

The TUI should run against the canonical `packages/core` plus `packages/server` runtime, not the quarantined OpenCode runtime. It should support sessions, prompts, streaming/replay, status, and auth-stub visibility. It should reserve a data workspace for Milestone 5, but it should not wire `gte-ts` data yet except as placeholders needed to validate layout.

## End State

After Milestone 4:

- `gta` launches the GTE Agent TUI.
- The TUI lives in a new `packages/tui` workspace built on OpenTUI plus Solid (both already in the root catalog), with `gta` as its bin entry. `packages/cli` remains the separate daemon/scripting CLI.
- `gte-agent` may remain as a developer or compatibility alias, but `gta` is the user-facing acceptance command.
- `gta` runs the canonical runtime in-process by default: the server runs in a worker inside the `gta` process and the TUI talks to it over an in-process channel. A real HTTP listener starts only with explicit network flags. `gte-agent serve` remains the headless server path.
- Users can create, list, select, and reopen sessions.
- Users can enter prompts, see deterministic demo-runner streaming output, and replay session history.
- The TUI shows clear local status, server status, session status, and errors.
- The TUI shows auth-stub status, including auth-disabled mode and synthetic principal/authority values when applicable.
- The TUI layout has a transcript/prompt area and a separate data workspace reserved for Milestone 5 panels.
- The data workspace can show empty states or placeholders, but it should not pretend market/account data exists before Milestone 5.
- Session-scoped UI intent exists for selected market, tracked address, and pinned data panels, even if the actual panels are placeholders. The intent is stored as typed optional fields on the session schema, exposed through the canonical session API, not as an untyped metadata blob.
- `packages/server` has route-level test coverage modeled on the opencode `httpapi-exercise` pattern, since the TUI depends on those routes.
- No coding-specific file panels, shell/file tools, diff/review UI, public share, sync, workspace, or editor-extension assumptions are active in the TUI.
- `packages/opencode` remains quarantined, excluded from root workspaces, not build-gated, and used only for reference.

## Scope

### User-Facing Command

`gta` is the Phase 1 TUI access point.

The product remains GTE Agent. Package identities may remain `@gte-agent/*`, environment variables should remain `GTE_AGENT_*`, and `gte-agent` may stay as a compatibility or developer alias. User-facing Phase 1 docs and acceptance should verify `gta`.

### TUI Package And Framework

The TUI is a new `packages/tui` workspace.

- Framework: OpenTUI plus Solid, already pinned in the root catalog and proven by the quarantined opencode TUI, whose interaction patterns map 1:1 to it.
- `gta` is the bin entry of `packages/tui`.
- `packages/cli` keeps the `gte-agent` daemon/scripting CLI. The boundary is: TUI is the user surface, CLI is the control surface.
- Old opencode TUI code is mined for patterns, not copied: it is coupled to the legacy session loop, share/sync, and filesystem assumptions, so expect rewrites against the canonical SDK rather than ports.

### Server Lifecycle

`gta` runs the canonical runtime in-process, mirroring the opencode worker pattern:

- On launch, `gta` spawns a worker that hosts the canonical server, and the TUI talks to it over an in-process channel (virtual URL, no TCP socket by default).
- A real HTTP listener starts only when explicit network flags are passed.
- The worker and any listener shut down when the TUI exits. Nothing is left running.
- `gte-agent serve` remains the explicit headless server path.
- Attaching the TUI to an already-running or remote server is a later capability; do not design the TUI in a way that forecloses it.

### Canonical Runtime Only

The TUI must talk to the canonical runtime:

- Canonical server routes.
- Canonical session create/list/prompt/events/messages/context surfaces.
- Canonical SDK/client where useful.
- Canonical local daemon flow.

It must not mount, import, or depend on legacy `packages/opencode` runtime paths.

### Minimal Session UX

Milestone 4 should include:

- Session list.
- Session create.
- Session select/reopen.
- Prompt input.
- Streaming output display.
- Message replay/history display.
- Local server/service status.
- Error display.
- Auth-stub display.

The UI should feel like a working tool, but it should stay intentionally narrow. Do not add trading workflows or market-data behavior in this milestone.

### Layout

The TUI should establish the Phase 1 layout:

- Main transcript and prompt work area.
- Session/status navigation.
- Separate data workspace for future market and account panels.

Milestone 5 will populate the data workspace. Milestone 4 should make room for it so the later data integration does not force a TUI redesign.

### Session-Scoped UI Intent

Store durable session intent, not process-local subscriptions:

- Selected market.
- Tracked address.
- Pinned data panels (the persisted record of which panels are open and on what key — panel type plus market symbol or address).

Store these as typed optional fields on the session schema (`Session.Info`), surfaced through the canonical session API with a dedicated update route and session events. Do not stuff them into an untyped JSON metadata column: the raw `metadata` column is not exposed through the API today, and there is no pre-MVP migration burden, so extending the schema cleanly is cheap. Milestone 4 may leave the values empty; Milestone 5 uses them to restore live panels on session reopen.

### Test Scaffolding

Milestone 4 extracts the reusable opencode test harness patterns:

- Add route-level tests for `packages/server` modeled on opencode's `httpapi-exercise` DSL (scenario-per-route coverage with request decoding, response shape, auth probes, and SSE checks). `packages/server` currently has no tests and the TUI depends on these routes.
- Use `@opentui/core/testing` in-memory rendering for TUI component tests, as the opencode TUI did.
- A subprocess harness in the style of opencode's `cli-process` may be added for `gta`/`gte-agent` smoke tests.
- No PTY-driven interactive TUI e2e harness is in scope; interactive acceptance stays manual in Milestone 6.

## `packages/opencode` Quarantine

The old OpenCode package may be mined for interaction patterns only.

Allowed:

- Reading old TUI code for UX ideas.
- Copying small, reviewed interaction patterns when they are rewritten against the canonical runtime.
- Recording patterns that should be kept or rejected before final deletion.

Not allowed:

- Making `packages/opencode` an active workspace.
- Importing its runtime, routes, session loop, share/sync paths, filesystem tools, or command surface.
- Treating its package as the TUI implementation.

## Removal Criteria For `packages/opencode`

Milestone 4 should start the final removal checklist for `packages/opencode`. Actual deletion may happen later, but the criteria should be explicit:

- `gta` TUI exists on the canonical runtime.
- No active imports, route mounts, package scripts, build scripts, tests, or SDK generation paths depend on `packages/opencode`.
- All useful TUI patterns have been copied, rewritten, or deliberately rejected.
- Docs no longer point future implementation work at `packages/opencode` except as historical context.
- The active TUI has no legacy share, sync, workspace, filesystem, shell, or coding-tool coupling.

## Out Of Scope

- `gte-ts` data integration.
- Market/account data panels beyond placeholders.
- Read-only GTE data tools.
- Real GTE login or token storage.
- Trading execution, order preview, signing, or mutation.
- Production persistence.
- Full TUI redesign for authenticated trading.
- Deleting `packages/opencode` unless all removal criteria are already satisfied.

## Implementation Checklist

1. Create the `packages/tui` workspace on OpenTUI plus Solid with `gta` as its bin entry, preserving `gte-agent` in `packages/cli` as the daemon/scripting CLI.
2. Build the active TUI against the canonical runtime with the in-process worker server flow (HTTP listener only behind explicit network flags).
3. Add session create/list/select/reopen UX.
4. Add prompt input and deterministic demo-runner streaming display.
5. Add history/replay display.
6. Add local status, server status, session status, and error display.
7. Add auth-stub display for auth-disabled mode and synthetic principal/authority.
8. Reserve the data workspace layout for Milestone 5.
9. Add typed session-scoped selected-market, tracked-address, and pinned-panel intent fields to the session schema and API, left empty until Milestone 5.
10. Add `httpapi-exercise`-style route tests for `packages/server` and `@opentui/core/testing` component tests for TUI pieces.
11. Remove or avoid coding-specific TUI panels/actions/defaults.
12. Keep `packages/opencode` quarantined and document any copied or rejected TUI and test-harness patterns.
13. Start the explicit `packages/opencode` removal checklist.

## Risks

- Reusing old OpenCode TUI code directly can reintroduce legacy session, share, sync, filesystem, or coding-tool assumptions.
- Making `gta` a thin alias to a legacy command would miss the Phase 1 goal.
- Hiding auth-stub status can make later account/address behavior ambiguous.
- Building market panels in M4 would couple the TUI shell to M5 before the data-tool boundary is designed.
- Failing to reserve a data workspace can force unnecessary redesign when M5 adds live data panels.
