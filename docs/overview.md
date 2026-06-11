# GTE Agent Retrofit Overview

This repository is a fork of opencode being retrofitted into GTE Agent. These docs may use GTA as short internal shorthand for GTE Agent, but the product and runtime direction should be written as GTE Agent.

opencode is an agentic coding runtime. GTE Agent should become an agentic trading runtime.

The working premise is that coding agents and trading agents have different centers of gravity. Coding agents spend meaningful time in both planning and implementation. Trading agents are more front-loaded: most value comes from context, judgment, risk awareness, and memory before execution. Execution itself can be nearly instant and can touch real liquidity, so the runtime must be stricter about authority, auditability, tool boundaries, and account context than a generic coding agent.

These docs are planning documents for future agents working in this repo. They intentionally describe the desired shape before implementation begins. Do not treat them as a completed architecture.

## Planning Status

This overview is documentation hardening only. It records target direction for future implementation, but it does not authorize implementation work by itself.

Phase 1 was provisionally accepted on 2026-06-11 (Milestone 6 record: `docs/m_6-acceptance-record.md`), but was reopened with Milestone 7: every agent reply was still the hardcoded demo stream, and Phase 1 cannot close while the agent has no real LLM. Phase 1 ends when the stripped OpenCode fork is a runnable, read-only GTE Agent terminal product with a real model behind it:

- GTE Agent is runnable through the user-facing `gta` command.
- `gta` launches the TUI, not a marketing shell or a browser app.
- The canonical runtime remains `packages/core` plus `packages/server`.
- Prompting a session streams a real LLM response from a user-selected model. The demo LLM client exists only behind `GTE_AGENT_LLM=demo` for tests and is never a silent fallback.
- `/models` in the TUI lets the user pick from a curated, GTE-owned catalog of Anthropic and OpenAI models, and authenticate the chosen provider by pasting an API key or signing in (Anthropic setup-token paste; OpenAI ChatGPT PKCE OAuth). LLM-provider credentials live in `~/.gte-agent/auth.json`.
- The model can call the read-only GTE data tools during a turn; tool results settle durably into the transcript.
- The TUI prompt offers slash-command autocomplete (command names plus model-ref and market-symbol arguments).
- GTE auth remains stubbed: no real GTE login, token storage, account binding, or trading authority selection UX. (LLM-provider auth above is separate from GTE auth.)
- Data access uses `gte-ts` through read-only client surfaces. Until `gte-ts` is published, it is consumed as a vendored workspace package copied verbatim from the exchange monorepo.
- Environment selection is configured through `GTE_AGENT_GTE_ENV`, whose valid values come from `gte-ts` named environment support (currently `hyperliquid-dev` and `hyperliquid-prod`).
- No trading mutation, signing, order placement, order cancel/replace, TWAP mutation, leverage setting, or ready-to-submit order payload generation is exposed.

Read-only in Phase 1 means no state-changing exchange calls. The agent may read public market data and public address-scoped account/portfolio data, and it may analyze that data. It must not submit, cancel, replace, preview, sign, or configure trades.

Phase 1 is composed of Milestones 1 through 7. Milestones 1 through 6 are complete: 1, 2, and 3 narrowed the repo, stabilized the canonical runtime, and added the auth/authority stub contract; 4, 5, and 6 added the `gta` TUI, read-only GTE data tools and panels, and whole-phase acceptance of those surfaces. Milestone 7 (real LLM responses, `/models`, provider auth, prompt autocomplete — see `docs/m_7-llm-models-auth-plan.md`) is the remaining work; Phase 1 closes again with its acceptance record. There is no production user base and no migration compatibility burden for old OpenCode, V1, workspace, share, or account SQLite chains before MVP.

`gte-agent` may remain as a developer or compatibility CLI alias for now. Phase 1 user-facing docs and acceptance should verify `gta`.

## Current Stripped Repo Shape

The repo has already been stripped to a smaller Bun monorepo skeleton. Active root workspaces are `packages/core`, `packages/server`, `packages/cli`, `packages/llm`, `packages/plugin`, `packages/sdk/js`, `packages/script`, `packages/http-recorder`, `packages/effect-drizzle-sqlite`, and `packages/effect-sqlite-node`, plus `packages/tui` (the `gta` TUI, added in Milestone 4) and `packages/gte-ts` (the vendored data SDK, added in Milestone 5).

- `packages/core`: the newer Effect-native core. It contains the strongest runtime substrate for GTE Agent: session admission, durable events, typed tools, permission primitives, context epochs, scoped service composition, local SQLite persistence, plugin hooks, provider/model plumbing, and public core exports. It still contains project, filesystem, V1/config compatibility, provider catalog, GitHub Copilot, account, workspace, plugin, skill, and coding-tool assumptions that must be removed, renamed, or explicitly quarantined before MVP.
- `packages/server`: the newer HTTP API layer. It exposes typed route groups over `packages/core`, but still uses V2 naming and route organization.
- `packages/cli`: a thin newer CLI for the server/daemon flow. It is not the interactive TUI.
- `packages/sdk/js`: generated JavaScript SDK. It still exposes V2/OpenCode naming and its generator still points at the current V2 server API.
- `packages/llm`: the generic LLM request/stream abstraction to preserve under GTE-owned provider/model policy.
- `packages/plugin`: plugin mechanism substrate. The mechanism may be useful later, but inherited defaults must not be active by default.
- `packages/effect-drizzle-sqlite`, `packages/effect-sqlite-node`, `packages/http-recorder`, and `packages/script`: runtime, persistence, testing, and build support packages.

`packages/opencode` was deleted in Milestone 6 after all removal criteria were met: its TUI interaction patterns and test-harness patterns (worker-hosted server, `httpapi-exercise` route DSL, `@opentui/core/testing` component tests, `cli-process` subprocess smoke tests) were extracted or deliberately rejected, as recorded in `docs/m_4-opencode-pattern-notes.md`. The package remains available in git history as historical reference.

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

Detailed trading execution tool design and memory design are out of scope for Phase 1. They should be acknowledged as core GTE Agent requirements, but not prematurely specified in these docs.

Phase 1 data tooling is intentionally read-only. It includes public market reads and explicit-address public account/portfolio reads from `gte-ts`. Because Phase 1 has no real auth, address-scoped reads require an explicit address or a session-scoped tracked address. In a later authenticated phase, account/portfolio tools should default to the authenticated user's address or trading authority where policy permits, while still allowing explicit tracked-address workflows when appropriate.

## Decisions Already Made

GTE Agent should use the newer architecture as the canonical runtime.

In practical terms, future work should converge around `packages/core` and `packages/server`, not the legacy session loop in `packages/opencode`. The name "V2" should be removed from product/runtime terminology once this is the only runtime.

GTE Agent auth should be GTE login only.

There is no org/workspace axis for the initial GTE Agent session model. GTE is an exchange. A session should bind to one authenticated GTE trading authority for its lifetime. That authority may later map to a user, subaccount, wallet, portfolio, venue account, or entitlement scope, but this overview should not lock that schema.

GTE/server-side persistence should be production-canonical.

Local SQLite is useful current substrate for local development, tests, and temporary runtime operation. It should not remain the final source of truth for production cross-entrypoint sessions tied to GTE login.

Until MVP, local SQLite has no compatibility burden. Milestone work may replace schemas and baselines cleanly instead of preserving historical OpenCode, V1, workspace, share, or account migrations.

`gte-ts` is consumed as a vendored workspace package until it is published.

The authoritative `gte-ts` source is the exchange monorepo at `packages/typescript/gte-ts`. Phase 1 vendors it verbatim into `packages/gte-ts`, with upstream provenance (repo path and commit SHA) recorded in a `VENDORED.md` and a sync script for refreshing from upstream. When `gte-ts` is published, the vendored copy should be replaced by the published dependency without API changes. The whole package is vendored, including the order/signing surface, to keep upstream diffs trivial; the active runtime imports only the read-only data client, and an automated import audit guards against mutation-surface imports.

`gta` runs the canonical runtime in-process.

The TUI launches the canonical server in a worker inside the `gta` process and talks to it over an in-process channel, mirroring the proven opencode worker pattern. A real HTTP listener starts only with explicit network flags. `gte-agent serve` remains the headless server path for scripting and daemons. Attaching the TUI to a remote server is a later capability, not a Phase 1 requirement.

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

Trading tools are central to GTE Agent, but the full execution tool catalog is out of scope for this pass. Phase 1 only defines read-only GTE data tools.

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

The user-facing TUI command is `gta`.

The TUI lives in `packages/tui` (the `gta` command), aligned to the canonical GTE Agent runtime, while `packages/cli` is the server/daemon CLI. The old opencode TUI was mined for interaction patterns (rewritten, never imported) and the package was deleted in Milestone 6; it carried no legacy session, API, route, tool, share, sync, server, auth/account, or filesystem assumptions into the new TUI.

Phase 1 TUI scope is a minimal GTE Agent workspace:

- Session create, list, select, prompt, streaming, replay, status, and errors.
- Auth-stub status and synthetic principal/authority visibility.
- A transcript/prompt work area.
- A separate data workspace for live-by-default GTE data panels.
- Session-scoped selected market, tracked address, and pinned panel intent.

Slash commands should open or focus live panels and record compact one-shot snapshots in the session transcript. Continuous stream updates should refresh panels without spamming the transcript. Agent-callable tools should remain one-shot reads for deterministic audit and replay.

## Out Of Scope For This Pass

The following topics should be mentioned as future work, not designed here:

- Full trading execution tool catalog beyond Phase 1 read-only data tools.
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

Phase 1 is composed of Milestones 1 through 7. Milestones 1 through 6 are complete (Milestone 6 acceptance is recorded in `docs/m_6-acceptance-record.md`); Milestone 7 is planned and reopens Phase 1 until its own acceptance record lands.

Completed Phase 1 milestones:

- Milestone 1: Strip To Skeleton. See `docs/m_1-strip-plan.md`.
- Milestone 2: Runtime Rename And Stabilization. See `docs/m_2-runtime-rename-plan.md`.
- Milestone 3: GTE Auth And Session Authority. See `docs/m_3-auth-authority-plan.md`.
- Milestone 4: `gta` TUI. See `docs/m_4-gta-tui-plan.md`.
- Milestone 5: Read-Only GTE Data Tools. See `docs/m_5-read-only-gte-data-tools-plan.md`.
- Milestone 6: Phase 1 Acceptance. See `docs/m_6-phase-1-acceptance-plan.md`.

Remaining Phase 1 milestone:

- Milestone 7: Real LLM Responses, `/models`, Provider Auth, And Prompt Autocomplete. See `docs/m_7-llm-models-auth-plan.md`.

Milestone 2 was canonical runtime rename and stabilization. Its goal was to make the newer runtime the only runtime in practice: cleanly rename OpenCode/V2 identity to GTE Agent, remove legacy V1 and workspace/runtime-context assumptions from active packages, point CLI/API/SDK at the canonical runtime, keep SQLite local/dev persistence working from a clean pre-product baseline, remove legacy routes from the active runtime, and preserve a minimal runnable skeleton that can create sessions, send prompts, stream deterministic model responses, and replay local history.

Milestone 3 was the GTE auth and session authority contract. See `docs/m_3-auth-authority-plan.md`.

The goal is to define the first real GTE boundary: GTE bearer-token validation or introspection, one immutable GTE trading authority per session, universal explicit authority selection during auth-enabled session creation, principal and authority ownership checks on canonical session reads and mutations, and the authority model that future tools must derive from. Trading execution remains out of scope.

Milestone 4 turned "keep the TUI experience" into an actual `gta` interface against the canonical runtime: a new `packages/tui` workspace built on OpenTUI plus Solid, an in-process worker server, no coding-specific panels/actions/default tools, prompt/session/status ergonomics preserved, the data workspace reserved, and `packages/opencode` interaction and test-harness patterns mined ahead of deletion.

Milestone 5 added read-only GTE data tools and TUI panels backed by the vendored `gte-ts`: public market reads, address-scoped public account/portfolio reads, shared symbol/address resolution, live-by-default TUI panels fed over the existing SSE event channel, one-shot agent tools with provenance, and the automated import audit guarding the read-only boundary.

Milestone 6 proved the Phase 1 surfaces end to end: `gta` launches the TUI, sessions and prompt streaming work, data panels and slash commands use the same read-only tool layer as the agent, `GTE_AGENT_GTE_ENV` configures data access, auth remains stubbed, no hidden trading mutation path is exposed, and `packages/opencode` was deleted after all removal criteria passed. Results and carried-forward limitations are recorded in `docs/m_6-acceptance-record.md`.

Milestone 7 makes the agent real: a curated Anthropic/OpenAI model catalog, the `/models` overlay with API-key paste and OAuth sign-in flows (Anthropic setup-token paste; OpenAI ChatGPT PKCE with a codex-responses adapter), LLM-provider credentials in `~/.gte-agent/auth.json`, per-session model selection with a global default, real streamed turns with the read-only data tools in the loop, a minimal GTE system prompt, and slash-command autocomplete in the prompt input. The demo LLM client moves behind `GTE_AGENT_LLM=demo`. Phase 1 closes when its acceptance record (`docs/m_7-acceptance-record.md`) lands.
