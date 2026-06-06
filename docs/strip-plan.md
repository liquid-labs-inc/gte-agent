# GTA Strip Plan

This document tracks what should be removed, retained, renamed, or deferred while converting the opencode fork into GTA.

The plan is intentionally staged. The first move is not to delete aggressively. The first move is to stabilize the canonical runtime seam, then strip around it. Deleting before naming the reusable runtime risks losing the substrate that makes cross-entrypoint sessions, typed tools, durable replay, and auditability possible.

## Guiding Principles

Prefer the newer core/runtime path.

GTA should converge around the architecture currently described as V2. In GTA, this should become the default runtime and should not retain "V2" naming in product-facing or long-term internal vocabulary.

Remove coding-product surface area.

If a feature exists only because opencode is a coding agent, it should be removed or quarantined. If it is a general runtime primitive, keep it for later classification.

Do not design the trading domain too early.

The first strip pass should make room for GTA. It should not pretend to have solved the tool catalog, memory system, real-liquidity execution semantics, or GTE persistence schema.

Prefer GTE-owned authority.

Auth, account authority, persistence, model policy, and execution policy should be GTE-owned in the final shape.

## Canonical Runtime First

Before broad deletion, define the core runtime seam:

- Session create/admit/prompt/resume.
- Durable event publication and replay.
- Typed tool registration and settlement.
- Permission/approval boundary.
- LLM request/stream boundary.
- Runtime context formerly represented by opencode `Location`.
- TUI/API/SDK access to the same session runtime.

Likely keepers:

- `packages/core/src/session*`
- `packages/core/src/event*`
- `packages/core/src/tool*`
- `packages/core/src/permission*`
- `packages/core/src/system-context*`
- `packages/core/src/location-layer.ts`, as a pattern to rename/redefine
- `packages/llm`
- `packages/server`, after renaming/removing V2 terminology

Likely legacy/quarantine areas:

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- Legacy V1 message/part hydration paths.
- Legacy opencode HTTP session handlers that still call the old session loop.
- Legacy coding tool defaults.

## Remove Completely

These are target removals, not necessarily the first patch.

### Browser UI

Remove browser UI surfaces:

- `packages/app`
- Browser app routes, stores, file panels, review/diff UI, terminal panels, and project/worktree launcher flows.
- Browser-only server selection and event-sync UI.

Reason: the final package should not ship UI components except the TUI.

### Web / Docs Product / Share

Remove:

- `packages/web`
- `packages/docs`
- Public share pages and share polling.
- Marketing/docs web app surfaces.
- Public session sharing.

Reason: public share should be removed completely for GTA. Trading sessions can contain account-sensitive, execution-sensitive, and compliance-sensitive material. If a sharing concept returns later, it should be a fresh authenticated/redacted/audited design, not inherited public secret-link snapshots. The root `docs/` folder is retained for internal retrofit planning and is distinct from the old product docs package.

### Desktop

Remove:

- `packages/desktop`
- Electron sidecar behavior.
- Desktop updater/distribution assets.

Reason: desktop depends on older opencode sidecar/server paths and is not part of the target package shape.

### Storybook And Browser UI Support

Remove:

- `packages/storybook`
- Browser UI story/test scaffolding tied to stripped components.
- Shared UI pieces that exist only for browser app/storybook surfaces.

Reason: the only retained UI surface should be TUI. Keep only UI code needed by TUI after classification.

### VS Code / Editor Extension

Remove:

- `sdks/vscode`

Reason: it is a terminal-oriented opencode extension, not a GTA runtime surface.

### Remote Workspace / Control Plane Sync

Remove:

- Remote workspace/worktree routing.
- Workspace sync/replay/steal semantics.
- Coding-workspace adapters.

Reason: opencode's remote workspace model is coding-specific and should not become GTA infrastructure. GTA cross-entrypoint continuity should come from GTE/server-side sessions, not workspace/worktree sync.

### Public Enterprise Share

Remove:

- Enterprise share snapshot routes/storage.

Reason: inherited share semantics are wrong for trading sessions unless redesigned from scratch.

## Keep Or Rework

### TUI

Keep the TUI as the only UI surface, but align it to the canonical runtime.

Current state:

- The interactive surface is embedded under `packages/opencode/src/cli`.
- The newer `packages/cli` is a V2 server/daemon CLI, not the TUI.

Target:

- A TUI package/surface that talks to the canonical GTA runtime.
- Old TUI code can be mined for interaction patterns.
- Do not preserve old session/tool/filesystem assumptions by default.

### CLI / API / SDK

Keep CLI/API/SDK as runtime entrypoints, with cleanup:

- CLI should start/connect to the canonical runtime.
- API should expose the canonical runtime, without V2 naming.
- SDK should generate from the canonical server API, not stale older opencode OpenAPI paths.
- Resolve binary/name mismatches such as `lildax`, `opencode`, and future GTA naming.

### Generic LLM Runtime

Keep:

- Canonical LLM request/stream abstraction.
- Provider integration as a runtime capability.

Rework:

- Provider/model selection policy should be GTE-owned.
- Do not preserve opencode's provider marketplace/config/catalog as the product default unless GTE later chooses that.

### Typed Tools

Keep the typed tool registry and durable settlement model.

Rework:

- Coding built-ins should not be default GTA tools.
- Trading mutation tools must be first-class typed tools with explicit authorization and audit semantics.
- Plugin/MCP tools can remain a future extension concept, but not as an uncontrolled route to trading mutation.

### Permissions

Keep the permission/approval primitive as a starting point.

Rework:

- Replace filesystem/coding resources with trading/account/action resources later.
- Real trading mutation approval needs a dedicated design.
- Saved approvals for trading actions should not be assumed safe.

### Context Epochs

Keep context epochs as audit substrate.

Clarify:

- They are not the trading memory system.
- They record privileged context shown to the model and can support auditability.

## Coding Tool Classification

Do not remove every tool blindly. Classify later:

- Remove if the tool is only useful for coding.
- Keep or rework if the tool is a general agent/runtime primitive.
- Defer if the tool is unclear or coupled to a future TUI/runtime decision.

Likely coding-specific removals from default GTA:

- File edit/write/apply-patch tools.
- Code search tools as default trading tools.
- Shell/bash as a default agent tool.
- Git/worktree/snapshot/revert/diff-specific surfaces.
- LSP and editor integration.

Potentially general primitives to revisit:

- Planning-oriented flows.
- Model selection surfaces, if adapted to GTE policy.
- Session/title/summary/compaction primitives.
- Question/approval prompts.
- Task/subagent concepts, if useful outside coding.

This classification is intentionally deferred. The barebones shape comes first.

## Auth And Account Scope

Target:

- Auth through GTE login.
- No org/workspace axis in the initial model.
- One session binds to one authenticated GTE account for its lifetime.

Implications:

- Replace Basic auth.
- Replace opencode hosted-console account/org assumptions.
- Replace local-only server password semantics.
- Tool execution authority must derive from the authenticated GTE account.

Unresolved:

- Exact GTE login protocol.
- Token refresh/storage.
- Session ownership enforcement.
- Trading account entitlement checks.

## Persistence

Target:

- GTE/server-side persistence is canonical.
- Local SQLite may remain only as a temporary/dev implementation if needed.

Keep as substrate:

- Durable event concepts.
- Session input admission.
- Projected read models.
- Event replay.

Rework:

- Storage location and ownership.
- Database schema naming.
- Cross-entrypoint access model.
- Recovery semantics for real trading execution.

## Runtime Context Replacement

Current opencode `Location` is directory/project/workspace oriented.

GTA rough target shape:

- GTE user.
- Authenticated GTE account.
- Market/trading context.

This is not final. It is a placeholder for future design. The important strip-plan decision is to preserve the scoped service composition pattern while removing filesystem/workspace semantics from the core product model.

## Deferred Decisions

These should be tracked but not specced in the first strip pass:

- Trading tool catalog.
- Trading memory.
- Real order execution design.
- Order idempotency and retry policy.
- Partial fill/cancel/replace semantics.
- Post-crash ambiguity and recovery.
- Commands and skills.
- TUI information architecture.
- Provider/model policy.
- Plugin/MCP role in GTA.
- Audit log shape for model output, tool input, approvals, order payloads, venue responses, and cancellations.

## Suggested First Milestones

1. Rename and stabilize the canonical runtime seam.
   Remove V2 terminology from the target architecture and make the newer runtime the only supported path.

2. Document package disposition.
   For each package, mark keep, remove, rework, or defer. Avoid code deletion until package ownership is clear.

3. Disconnect legacy session assumptions.
   Quarantine old `SessionPrompt`/V1 loop paths from the canonical runtime plan.

4. Define the minimal GTA auth/session contract.
   GTE login, one account per session, server-side persistence as canonical.

5. Plan TUI alignment.
   Decide whether to carve out or recreate the TUI package against the canonical runtime.

6. Only then begin removal patches.
   Start with surfaces that are already decided: desktop, browser app, public share, storybook, web/docs product, VS Code extension, and remote workspace sync.
