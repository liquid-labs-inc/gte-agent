# GTA Retrofit Overview

This repository is a fork of opencode being retrofitted into GTE Agent, also referred to as GTA. opencode is an agentic coding runtime. GTA should become an agentic trading runtime.

The working premise is that coding agents and trading agents have different centers of gravity. Coding agents spend meaningful time in both planning and implementation. Trading agents are more front-loaded: most value comes from context, judgment, risk awareness, and memory before execution. Execution itself can be nearly instant and can touch real liquidity, so the runtime must be stricter about authority, auditability, tool boundaries, and account context than a generic coding agent.

These docs are planning documents for future agents working in this repo. They intentionally describe the desired shape before implementation begins. Do not treat them as a completed architecture.

## Current Repo Shape

The repo is a Bun monorepo with several overlapping opencode surfaces:

- `packages/core`: the newer Effect-native core. This contains the strongest runtime substrate for GTA: session admission, durable events, typed tools, permission primitives, context epochs, location-scoped service composition, and the public core API.
- `packages/server`: the newer V2 HTTP API layer. It exposes typed route groups over the `packages/core` runtime.
- `packages/cli`: a thin newer CLI for the V2 server/daemon flow. It is not the interactive TUI.
- `packages/opencode`: the older/main opencode package. It contains the legacy interactive CLI/TUI, legacy session loop, coding tools, old HTTP server surfaces, auth/account glue, and compatibility code.
- `packages/sdk/js`: generated JavaScript SDK. It exports both older and newer clients, but the generation flow still points at older opencode surfaces.
- `packages/app`, `packages/web`, `packages/docs`, `packages/desktop`, `packages/storybook`, `packages/ui`, `sdks/vscode`: browser UI, docs/web/share, desktop, storybook, shared UI, and editor-extension surfaces that are mostly coding-product oriented.
- `packages/console`, `packages/enterprise`, `packages/slack`, `packages/stats`: hosted/product/analytics/share-adjacent surfaces that should not be assumed relevant to GTA without a fresh decision.

There are two generations of runtime code in the repo. GTA should align with the newer V2 architecture, but in GTA this should not be called "V2"; it should be the only runtime.

## GTA Direction

GTA is the trading-native evolution of this agent runtime. Its differentiators are:

- Trading-native tools, including the eventual ability to execute with real liquidity.
- Memory tuned for markets and trading behavior rather than generic recall.
- Runtime-agnostic operation across entrypoints, with sessions carrying coherently across surfaces.
- Authentication through GTE.
- Session authority tied to one authenticated GTE account.

Detailed trading tool design and memory design are out of scope for this pass. They should be acknowledged as core GTA requirements, but not prematurely specified in these docs.

## Decisions Already Made

GTA should use the newer V2 architecture as the canonical runtime.

In practical terms, that means future work should converge around `packages/core` and `packages/server`, not the legacy session loop in `packages/opencode`. The name "V2" should be removed from product/runtime terminology once this is the only runtime.

GTA auth should be GTE login only.

There is no org/workspace axis for the initial GTA shape. GTE is an exchange. A session should bind to one authenticated GTE account for its lifetime.

GTE/server-side persistence should be canonical.

Local SQLite can remain as a temporary or development implementation if useful, but the product direction is cross-entrypoint sessions tied to GTE login. That is awkward if canonical session state lives only on one local machine.

The only UI surface to keep is the TUI.

Desktop, browser app, old docs web app, storybook, public share, and editor-extension UI surfaces are not part of the target package shape. The root `docs/` folder is for internal retrofit planning; it is not the old shipped docs product. The TUI should align to the canonical runtime instead of preserving legacy opencode session assumptions.

Remote workspace/control-plane sync should be removed.

opencode's workspace/worktree sync model is coding-specific and should not be reframed as GTA infrastructure in this pass.

Generic LLM request/provider abstraction should stay, but provider/model policy should be GTE-owned.

The runtime needs a model layer. GTA should not retain opencode's provider marketplace/config/catalog as a product surface unless GTE explicitly chooses that later.

## Runtime Substrate To Preserve

The following pieces look like strong reusable substrate for GTA:

- Durable session admission and resume semantics from `SessionV2`.
- Event-sourced session history and replay through `EventV2`.
- Projected message read models for transcript-style consumers.
- Typed tool registry and durable tool settlement in `packages/core/src/tool`.
- Permission ask/reply primitives, with trading-specific action/resource semantics added later.
- Context epochs for recording exactly what privileged context was shown to the model.
- The canonical LLM request/stream abstraction in `packages/llm`.
- Location-scoped service composition, but with "Location" renamed and redefined for GTA.

These are substrate decisions, not direct drop-in product decisions. The domain vocabulary must change.

## GTA Runtime Context

The current runtime uses `Location`, which is filesystem/project/workspace oriented. GTA needs a different runtime context.

The rough shape is:

- GTE user identity.
- One authenticated GTE account bound to the session.
- Market/trading context needed by the active agent run.

This is intentionally rough and must be fleshed out later. Do not prematurely lock a schema from this overview. The useful pattern to preserve is scoped runtime services; the specific opencode `Location` fields are not the GTA domain.

## Tools

Trading tools are central to GTA, but the full tool catalog is out of scope for this pass.

The planning distinction is:

- Coding-only tools and surfaces should be removed from the default GTA product.
- Generally useful runtime primitives can be retained for later classification.
- Trading execution tools must eventually be first-class, typed, audited, and risk-gated.
- Arbitrary plugin or MCP execution should not be a path to real trading mutation unless wrapped by explicit GTA policy and typed tool boundaries.

Examples of future trading-native tool categories may include market data, account/portfolio reads, order preview, order submission, cancel/replace, risk checks, venue status, and execution audit. This list is illustrative, not a spec.

## Memory

Trading memory is a core GTA requirement, but detailed memory design is out of scope.

Do not confuse context epochs with trading memory. Context epochs help preserve and audit privileged context shown to the model. Trading memory should be a separate design concerned with market behavior, user behavior, trading decisions, post-trade outcomes, and retrieval before execution.

## TUI Direction

The target package should keep only the TUI as a user interface.

The current interactive surface lives inside `packages/opencode/src/cli`, while the newer `packages/cli` is a server/daemon CLI. The target should be a TUI aligned to the canonical runtime. It may mine the old opencode TUI for interaction patterns, but should not preserve legacy session, API, tool, or filesystem assumptions by default.

## Out Of Scope For This Pass

The following topics should be mentioned as future work, not designed here:

- Full trading tool catalog.
- Trading memory architecture.
- Real-liquidity execution semantics.
- Order idempotency, retry, partial-fill, and post-crash ambiguity policy.
- Commands and skills.
- Exact TUI redesign.
- Exact GTE auth protocol.
- Exact server-side persistence schema.
- Provider/model policy details.

## Immediate Planning Goal

The first planning milestone is not heavy coding. It is:

1. Define and name the canonical runtime seam now that V2 becomes the only runtime.
2. Map which packages and surfaces are keep, remove, or defer.
3. Avoid designing trading tools and memory prematurely.
4. Produce enough clarity that implementation can start without carrying legacy opencode ambiguity into every change.
