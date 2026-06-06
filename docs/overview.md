# GTE Agent Retrofit Overview

This repository is a fork of opencode being retrofitted into GTE Agent. These docs may use GTA as short internal shorthand for GTE Agent, but the product and runtime direction should be written as GTE Agent.

opencode is an agentic coding runtime. GTE Agent should become an agentic trading runtime.

The working premise is that coding agents and trading agents have different centers of gravity. Coding agents spend meaningful time in both planning and implementation. Trading agents are more front-loaded: most value comes from context, judgment, risk awareness, and memory before execution. Execution itself can be nearly instant and can touch real liquidity, so the runtime must be stricter about authority, auditability, tool boundaries, and account context than a generic coding agent.

These docs are planning documents for future agents working in this repo. They intentionally describe the desired shape before implementation begins. Do not treat them as a completed architecture.

## Current Repo Shape

The repo is a Bun monorepo with several overlapping opencode generations and product surfaces. The package boundaries are not clean: newer runtime substrate still contains coding/project assumptions, and the older opencode package already contains bridge paths into newer APIs.

- `packages/core`: the newer Effect-native core. It contains the strongest runtime substrate for GTE Agent: session admission, durable events, typed tools, permission primitives, context epochs, location-scoped service composition, local SQLite persistence, plugin hooks, provider/model plumbing, and the public core API. It also still contains project, filesystem, V1/config compatibility, provider catalog, GitHub Copilot, share, plugin, skill, and coding-tool assumptions that need classification.
- `packages/server`: the newer HTTP API layer. It exposes typed route groups over the `packages/core` runtime, but still uses V2 naming and route organization.
- `packages/cli`: a thin newer CLI for the server/daemon flow. It is not the interactive TUI.
- `packages/opencode`: the older/main opencode package. It contains the legacy interactive CLI/TUI, legacy session loop, coding tools, old HTTP server surfaces, auth/account glue, compatibility code, share/sync/workspace/MCP surfaces, and some newer API bridge paths.
- `packages/sdk/js`: generated JavaScript SDK. It exports both older and newer clients, but the generation flow still points through older opencode surfaces.
- `packages/app`, `packages/web`, `packages/docs`, `packages/desktop`, `packages/storybook`, `packages/ui`, `sdks/vscode`: browser UI, docs/web/share, desktop, storybook, shared browser UI, and editor-extension surfaces that are coding-product oriented.
- `packages/console`, `packages/enterprise`, `packages/slack`, `packages/stats`, `github`, `.github`: hosted OpenCode product, sharing, analytics, Slack, GitHub action, release, CI, localization, and distribution surfaces that are removal targets. Any reusable value must be explicitly proven and carved out before deletion.
- `packages/plugin`, `.opencode`, MCP, commands, and skills: extension mechanisms and inherited OpenCode content. The mechanisms are likely useful future substrate; inherited defaults and coding/product content need pruning.
- `packages/llm`, `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node`, `packages/http-recorder`, `packages/script`, `packages/function`, `packages/containers`, `packages/identity`, `infra`, `nix`, `script`: runtime, persistence, testing, build, infrastructure, branding, and automation support surfaces that need explicit keep/remove/rework disposition.
- `specs/`, `packages/opencode/specs`, package READMEs, translated root READMEs, and localized docs: inherited planning and product docs. They are historical unless promoted into the new GTE Agent planning docs.

There are two generations of runtime code in the repo. GTE Agent should align with the newer architecture currently described as V2, but in GTE Agent this should not be called "V2"; it should be the only runtime.

## GTE Agent Direction

GTE Agent is the trading-native evolution of this agent runtime. Its differentiators are:

- Trading-native tools, including the eventual ability to execute with real liquidity.
- Memory tuned for markets and trading behavior rather than generic recall.
- Runtime-agnostic operation across entrypoints, with sessions carrying coherently across surfaces.
- Authentication through GTE.
- Session authority tied to one authenticated GTE trading authority.

Detailed trading tool design and memory design are out of scope for this pass. They should be acknowledged as core GTE Agent requirements, but not prematurely specified in these docs.

## Decisions Already Made

GTE Agent should use the newer architecture as the canonical runtime.

In practical terms, future work should converge around `packages/core` and `packages/server`, not the legacy session loop in `packages/opencode`. The name "V2" should be removed from product/runtime terminology once this is the only runtime.

GTE Agent auth should be GTE login only.

There is no org/workspace axis for the initial GTE Agent session model. GTE is an exchange. A session should bind to one authenticated GTE trading authority for its lifetime. That authority may later map to a user, subaccount, wallet, portfolio, venue account, or entitlement scope, but this overview should not lock that schema.

GTE/server-side persistence should be production-canonical.

Local SQLite is useful current substrate for local development, tests, and temporary runtime operation. It should not remain the final source of truth for production cross-entrypoint sessions tied to GTE login.

The only UI surface to keep is the TUI.

Desktop, browser app, old docs web app, storybook, public share, and editor-extension UI surfaces are not part of the target package shape. The root `docs/` folder is for internal retrofit planning; it is not the old shipped docs product. The TUI should be carved toward the canonical runtime instead of preserving legacy opencode session, server, tool, share, sync, or filesystem assumptions.

Public sharing should be removed.

Inherited secret-link sharing is a cross-cutting OpenCode product feature. It includes local schema, share sync, SDK/API endpoints, CLI/TUI commands, web/enterprise/console pages, GitHub/Slack integration, tests, docs, and config flags. Trading sessions can contain account-sensitive, execution-sensitive, and compliance-sensitive material. Any future sharing concept should be a fresh authenticated, redacted, audited design.

Remote workspace/control-plane sync should be removed.

opencode's workspace/worktree sync model is coding-specific and should not be reframed as GTE Agent infrastructure in this pass. GTE Agent cross-entrypoint continuity should come from GTE/server-side sessions, not workspace/worktree sync.

Generic LLM request/provider execution should stay, but provider/model policy should be GTE-owned.

The runtime needs a model layer. GTE Agent should not retain opencode's provider marketplace, hosted-console provider config, public provider catalog, or product docs as the default policy unless GTE explicitly chooses that later.

Plugin, MCP, command, and skill mechanisms should stay as future extension primitives.

Not all inherited OpenCode plugins, MCP defaults, commands, or skills should stay. The mechanisms should be modified later under GTE-owned policy, especially before any path can perform trading mutation.

Root product documentation should collapse to one temporary English README plus internal planning docs.

Translated root READMEs, localized docs content, `.opencode/glossary`, docs-locale sync automation, and old OpenCode product docs should be removed or rewritten during the strip milestone.

Hosted OpenCode product and distribution surfaces should be stripped after proving deletion boundaries.

`packages/console`, `packages/stats`, `packages/slack`, `github`, `.github` workflows, release scripts, and related docs/tests/env/config are removal targets. Any concrete reusable GTE Agent substrate must be identified and carved out before deletion.

## Runtime Substrate To Preserve

The following pieces look like strong reusable substrate for GTE Agent:

- Durable session admission and resume semantics from `SessionV2`, renamed away from V2 terminology.
- Event-sourced session history and replay through `EventV2`, renamed away from V2 terminology.
- Projected message read models for transcript-style consumers.
- Typed tool registry and durable tool settlement in `packages/core/src/tool`.
- Permission ask/reply primitives, with trading-specific action/resource semantics added later.
- Context epochs for recording exactly what privileged context was shown to the model.
- The canonical LLM request/stream abstraction in `packages/llm`.
- Local SQLite persistence as development/test/local substrate.
- Location-scoped service composition, but with "Location" renamed and redefined for GTE Agent.
- Extension mechanisms for plugins, MCP, commands, and skills, after inherited OpenCode defaults are pruned.

These are substrate decisions, not direct drop-in product decisions. The domain vocabulary must change.

## GTE Agent Runtime Context

The current runtime uses `Location`, which is filesystem/project/workspace oriented. GTE Agent needs a different runtime context.

The rough shape is:

- GTE user identity.
- One authenticated GTE trading authority bound to the session.
- Market/trading context needed by the active agent run.

This is intentionally rough and must be fleshed out later. Do not prematurely lock a schema from this overview. The useful pattern to preserve is scoped runtime services; the specific opencode `Location` fields are not the GTE Agent domain.

## Tools

Trading tools are central to GTE Agent, but the full tool catalog is out of scope for this pass.

The planning distinction is:

- Coding-only tools and product defaults should be removed from the default GTE Agent product.
- Generally useful runtime primitives can be retained for later classification.
- Plugin, MCP, command, and skill mechanisms should be retained but pruned and governed by future GTE policy.
- Trading execution tools must eventually be first-class, typed, audited, and risk-gated.
- Arbitrary plugin or MCP execution should not be a path to real trading mutation unless wrapped by explicit GTE Agent policy and typed tool boundaries.

Examples of future trading-native tool categories may include market data, account/portfolio reads, order preview, order submission, cancel/replace, risk checks, venue status, and execution audit. This list is illustrative, not a spec.

## Memory

Trading memory is a core GTE Agent requirement, but detailed memory design is out of scope.

Do not confuse context epochs with trading memory. Context epochs help preserve and audit privileged context shown to the model. Trading memory should be a separate design concerned with market behavior, user behavior, trading decisions, post-trade outcomes, and retrieval before execution.

## TUI Direction

The target package should keep only the TUI as a user interface.

The current interactive surface lives inside `packages/opencode/src/cli`, while the newer `packages/cli` is a server/daemon CLI. The target should be a TUI aligned to the canonical GTE Agent runtime. It may mine the old opencode TUI for interaction patterns, but should not preserve legacy session, API, tool, share, sync, server, or filesystem assumptions by default.

Keep the TUI experience and interaction patterns. Do not treat the current `packages/opencode` package as a keeper.

## Out Of Scope For This Pass

The following topics should be mentioned as future work, not designed here:

- Full trading tool catalog.
- Trading memory architecture.
- Real-liquidity execution semantics.
- Order idempotency, retry, partial-fill, and post-crash ambiguity policy.
- Exact TUI redesign.
- Exact GTE auth protocol.
- Exact server-side persistence schema.
- Provider/model policy details.
- Final plugin/MCP/command/skill policy.
- Final public or internal sharing/export/audit-report design.

## Immediate Planning Goal

The first planning milestone is Milestone 1: Strip To Skeleton.

Its job is not to finish GTE Agent. It should:

1. Define and name the canonical runtime seam now that V2 becomes the only runtime.
2. Map which packages and surfaces are keep, remove, rework, or defer.
3. Prove clean deletion boundaries for inherited OpenCode product surfaces.
4. Strip stale OpenCode docs, localization, product UI, public share, hosted product, distribution, and automation surfaces.
5. Preserve the runtime substrate needed for sessions, events, typed tools, permissions, LLM execution, local persistence, extension mechanisms, and a future TUI.
6. Avoid designing trading tools, trading memory, real execution, and final GTE auth/persistence prematurely.
7. Produce enough clarity that implementation can start without carrying legacy opencode ambiguity into every change.

## Tentative Next Milestones

These are directional follow-ups, not fully planned milestones.

Milestone 2 may be canonical runtime rename and stabilization.

The goal would be to make the newer runtime the only runtime in practice: remove V2 terminology, retire legacy session loop paths, point CLI/API/SDK at the canonical runtime, keep SQLite local/dev persistence working, and preserve a minimal runnable skeleton that can create sessions, send prompts, stream model responses, and replay local history.

Milestone 3 may be the GTE auth and session authority contract.

The goal would be to define the first real GTE boundary: GTE login shape, one GTE trading authority per session, production ownership checks, and the authority model that future tools must derive from. Trading execution should still remain out of scope except for authority modeling.

Milestone 4 may be the TUI carve-out.

The goal would be to turn "keep the TUI experience" into an actual GTE Agent interface against the canonical runtime: remove coding-specific panels/actions/default tools, keep prompt/session/model/status ergonomics, and leave room for future market/account context without designing trading workflows yet.
