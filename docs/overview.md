# GTE Agent Retrofit Overview

This repository is a fork of opencode being retrofitted into GTE Agent. These docs may use GTA as short internal shorthand for GTE Agent, but the product and runtime direction should be written as GTE Agent.

opencode is an agentic coding runtime. GTE Agent should become an agentic trading runtime.

The working premise is that coding agents and trading agents have different centers of gravity. Coding agents spend meaningful time in both planning and implementation. Trading agents are more front-loaded: most value comes from context, judgment, risk awareness, and memory before execution. Execution itself can be nearly instant and can touch real liquidity, so the runtime must be stricter about authority, auditability, tool boundaries, and account context than a generic coding agent.

These docs are planning documents for future agents working in this repo. They intentionally describe the desired shape before implementation begins. Do not treat them as a completed architecture.

## Planning Status

This overview is documentation hardening only. It records target direction for future implementation, but it does not authorize implementation work by itself.

Milestone 1 has narrowed the repo shape. Milestones 2 and 3 should be treated as one long pre-MVP chain: first stabilize and rename the canonical runtime, then add the GTE auth and authority contract. There is no production user base and no migration compatibility burden for old OpenCode, V1, workspace, share, or account SQLite chains before MVP.

## Current Stripped Repo Shape

The repo has already been stripped to a smaller Bun monorepo skeleton. Active root workspaces are `packages/core`, `packages/server`, `packages/cli`, `packages/llm`, `packages/plugin`, `packages/sdk/js`, `packages/script`, `packages/http-recorder`, `packages/effect-drizzle-sqlite`, and `packages/effect-sqlite-node`.

- `packages/core`: the newer Effect-native core. It contains the strongest runtime substrate for GTE Agent: session admission, durable events, typed tools, permission primitives, context epochs, scoped service composition, local SQLite persistence, plugin hooks, provider/model plumbing, and public core exports. It still contains project, filesystem, V1/config compatibility, provider catalog, GitHub Copilot, account, workspace, plugin, skill, and coding-tool assumptions that must be removed, renamed, or explicitly quarantined before MVP.
- `packages/server`: the newer HTTP API layer. It exposes typed route groups over `packages/core`, but still uses V2 naming and route organization.
- `packages/cli`: a thin newer CLI for the server/daemon flow. It is not the interactive TUI.
- `packages/sdk/js`: generated JavaScript SDK. It still exposes V2/OpenCode naming and its generator still points at the current V2 server API.
- `packages/llm`: the generic LLM request/stream abstraction to preserve under GTE-owned provider/model policy.
- `packages/plugin`: plugin mechanism substrate. The mechanism may be useful later, but inherited defaults must not be active by default.
- `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node`, `packages/http-recorder`, and `packages/script`: runtime, persistence, testing, and build support packages.

`packages/opencode` still exists on disk, but it is quarantined reference material only. It is excluded from root workspaces, should not be build-gated, and should not be imported by the active runtime. Its value is limited to mining TUI interaction patterns for a later carve-out.

Removed OpenCode product surfaces include browser app, web/docs product, desktop, Storybook, VS Code extension, hosted console/stats/slack surfaces, localization docs, public sharing product surfaces, and release/deploy automation. Historical OpenCode docs/specs live under `docs/historical-opencode` unless explicitly promoted into GTE Agent planning docs.

The active GTE Agent runtime should converge on the newer `packages/core` plus `packages/server` architecture. In target docs this is not "V2"; it is the only runtime.

Legacy opencode routes, handlers, session loops, and server surfaces must be removed from, or unreachable by, the active runtime. Active CLI/API/SDK paths should not import `packages/opencode`, register its routes, or generate contracts from its legacy HTTP surface.

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

Until MVP, local SQLite has no compatibility burden. Milestone work may replace schemas and baselines cleanly instead of preserving historical OpenCode, V1, workspace, share, or account migrations.

The only UI surface to keep is the TUI.

Desktop, browser app, old docs web app, storybook, public share, and editor-extension UI surfaces are not part of the target package shape. The root `docs/` folder is for internal retrofit planning; it is not the old shipped docs product. The TUI should be carved toward the canonical runtime instead of preserving legacy opencode session, server, tool, share, sync, or filesystem assumptions.

Public sharing should be removed.

Inherited secret-link sharing is a cross-cutting OpenCode product feature. It includes local schema, share sync, SDK/API endpoints, CLI/TUI commands, web/enterprise/console pages, GitHub/Slack integration, tests, docs, and config flags. Trading sessions can contain account-sensitive, execution-sensitive, and compliance-sensitive material. Any future sharing concept should be a fresh authenticated, redacted, audited design.

Remote workspace/control-plane sync should be removed.

opencode's workspace/worktree sync model is coding-specific and should not be reframed as GTE Agent infrastructure in this pass. GTE Agent cross-entrypoint continuity should come from GTE/server-side sessions, not workspace/worktree sync.

Legacy route surfaces that depend on workspace or legacy session semantics should be deleted from the active runtime or made unreachable. They should not be kept as compatibility paths.

Generic LLM request/provider execution should stay, but provider/model policy should be GTE-owned.

The runtime needs a model layer. GTE Agent should not retain opencode's provider marketplace, hosted-console provider config, public provider catalog, or product docs as the default policy unless GTE explicitly chooses that later.

Plugin, MCP, command, and skill mechanisms should stay as future extension primitives.

Not all inherited OpenCode plugins, MCP defaults, commands, or skills should stay. The mechanisms should be modified later under GTE-owned policy, especially before any path can perform trading mutation.

Root product documentation should collapse to one temporary English README plus internal planning docs.

Translated root READMEs, localized docs content, `.opencode/glossary`, docs-locale sync automation, and old OpenCode product docs were strip-milestone targets. Remaining docs should be treated as internal planning material unless explicitly promoted.

Hosted OpenCode product and distribution surfaces should stay stripped.

Do not add back hosted OpenCode product, public share, release, localization, desktop, browser, or editor-extension surfaces unless a later milestone explicitly defines a GTE Agent product requirement for them.

## Runtime Substrate To Preserve

The following pieces look like strong reusable substrate for GTE Agent:

- Durable session admission and resume semantics from `SessionV2`, renamed away from V2 terminology.
- Event-sourced session history and replay through `EventV2`, renamed away from V2 terminology.
- Projected message read models for transcript-style consumers.
- Typed tool registry and durable tool settlement in `packages/core/src/tool`.
- Permission ask/reply primitives, with trading-specific action/resource semantics added later.
- Context epochs for recording exactly what privileged context was shown to the model.
- The canonical LLM request/stream abstraction in `packages/llm`.
- Local SQLite persistence as development/test/local substrate, with no historical migration compatibility burden before MVP.
- Scoped service composition, but with "Location" replaced by a neutral runtime scope and stripped of filesystem/workspace semantics that are not needed for the local skeleton.
- Extension mechanisms for plugins, MCP, commands, and skills, after inherited OpenCode defaults are pruned.

These are substrate decisions, not direct drop-in product decisions. The domain vocabulary must change.

## GTE Agent Runtime Context

The current runtime uses `Location`, which is filesystem/project/workspace oriented. GTE Agent needs a different runtime context. Milestone 2 should introduce only a neutral local runtime scope needed for the skeleton. Milestone 3 should add authenticated principal and trading authority semantics after that scope exists.

The eventual shape is:

- GTE user identity.
- One authenticated GTE trading authority bound to the session.
- Market/trading context needed by the active agent run.

This is intentionally rough and must be fleshed out later. Do not prematurely lock a schema from this overview. The useful pattern to preserve is scoped runtime services; the specific opencode `Location`, `workspace`, and filesystem fields are not the GTE Agent domain.

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

The current interactive surface lives inside `packages/opencode/src/cli`, while the newer `packages/cli` is a server/daemon CLI. The target should be a TUI aligned to the canonical GTE Agent runtime. It may mine the old opencode TUI for interaction patterns, but should not preserve legacy session, API, route, tool, share, sync, server, auth/account, or filesystem assumptions by default.

Keep the TUI experience and interaction patterns. Do not treat the current `packages/opencode` package as a keeper or runtime dependency.

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

## Milestone 1 Retrospective

The first planning milestone was Milestone 1: Strip To Skeleton.

Its job was not to finish GTE Agent. It was meant to:

1. Define and name the canonical runtime seam now that V2 becomes the only runtime.
2. Map which packages and surfaces are keep, remove, rework, or defer.
3. Prove clean deletion boundaries for inherited OpenCode product surfaces.
4. Strip stale OpenCode docs, localization, product UI, public share, hosted product, distribution, and automation surfaces.
5. Preserve the runtime substrate needed for sessions, events, typed tools, permissions, LLM execution, local persistence, extension mechanisms, and a future TUI.
6. Avoid designing trading tools, trading memory, real execution, and final GTE auth/persistence prematurely.
7. Produce enough clarity that implementation can start without carrying legacy opencode ambiguity into every change.

## Next Milestones

Each milestone plan should include an explicit End State section. The End State should describe the expected repository and runnable app state after the milestone so future agents can work toward the same target instead of only following a task list.

Milestones 2 and 3 are a single pre-MVP hardening chain. See `docs/m_2-runtime-rename-plan.md` and `docs/m_3-auth-authority-plan.md`.

Milestone 2 is canonical runtime rename and stabilization. Its goal is to make the newer runtime the only runtime in practice: cleanly rename OpenCode/V2 identity to GTE Agent, remove legacy V1 and workspace/runtime-context assumptions from active packages, point CLI/API/SDK at the canonical runtime, keep SQLite local/dev persistence working from a clean pre-product baseline, remove legacy routes from the active runtime, and preserve a minimal runnable skeleton that can create sessions, send prompts, stream deterministic model responses, and replay local history.

Milestone 3 is the GTE auth and session authority contract. See `docs/m_3-auth-authority-plan.md`.

The goal is to define the first real GTE boundary: GTE bearer-token validation or introspection, one immutable GTE trading authority per session, universal explicit authority selection during auth-enabled session creation, principal and authority ownership checks on canonical session reads and mutations, and the authority model that future tools must derive from. Trading execution remains out of scope.

Milestone 4 may be the TUI carve-out.

The goal would be to turn "keep the TUI experience" into an actual GTE Agent interface against the canonical runtime: remove coding-specific panels/actions/default tools, keep prompt/session/model/status ergonomics, and leave room for future market/account context without designing trading workflows yet.
