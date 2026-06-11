# Milestone 2: Runtime Rename And Stabilization

This document is the source-of-truth plan for Milestone 2 of the GTE Agent retrofit.

Phase 1 status: completed in the current Phase 1 branch. This document remains as the source-of-truth plan and retrospective for the runtime rename/stabilization milestone. Later Phase 1 docs supersede the user-facing CLI command detail: `gta` is the TUI access command, while `gte-agent` may remain as a developer or compatibility alias.

Milestone 2 should make the canonical runtime clean, runnable, and GTE Agent named end to end. It should not implement GTE auth, trading tools, trading memory, market data, balances, risk checks, or execution semantics.

Milestone 2 is documentation for future implementation. It is part of one long pre-MVP hardening chain with Milestone 3. There is no migration compatibility burden for old OpenCode, V1, workspace, share, or account data before MVP.

## Goal

Turn the post-Milestone-1 skeleton into a clean GTE Agent runtime skeleton.

The newer runtime should no longer be treated as "V2"; it should be the only active runtime. Active workspace packages should use GTE Agent names, clean API/SDK contracts, neutral runtime scope vocabulary, a clean pre-product SQLite baseline, and a minimal local flow that can create sessions, admit prompts, stream model output, persist events/messages, and replay local history.

## End State

After Milestone 2:

- Active workspace packages use `@gte-agent/*` package identities and imports.
- The product and CLI binary are named `gte-agent`.
- Active code no longer exposes OpenCode, opencode, lildax, V2, V1 session compatibility, workspace, or legacy session-loop terminology as canonical runtime vocabulary.
- Generic HTTP resource paths such as `/api/session` may remain, but OpenAPI group names, generated identifiers, SDK namespaces, service tags, env vars, local paths, and client helpers use GTE Agent naming.
- `packages/sdk/js` is regenerated from the renamed canonical server API and exposes canonical non-`v2` paths such as `@gte-agent/sdk/client`.
- SQLite starts from a clean pre-product baseline migration. Existing OpenCode/V1/workspace/share migration chains are not preserved for compatibility.
- The active server API includes a canonical create-session endpoint with a neutral runtime-scope payload.
- The `gte-agent` CLI can start or connect to the local server, create a session through the canonical HTTP API, admit a prompt, stream a model response through the generic LLM abstraction, persist canonical events/messages in SQLite, and replay or list local session history.
- Coding built-in tools, filesystem/search routes, shell/file mutation defaults, and inherited command/skill/plugin/MCP default loading are removed or disabled from the default runtime.
- Typed tool registry and durable settlement substrate remain, with only neutral test/demo tooling if needed for verification.
- Plugin, MCP, command, and skill mechanisms remain as substrate, but inherited default runtime loading is disabled until later milestones add proper GTE policy.
- Provider/model support remains only as policy-neutral generic LLM routing needed for the skeleton. OpenCode-branded provider marketplace/catalog defaults, GitHub Copilot product assumptions, and hosted-console provider policy are removed from the active runtime unless explicitly justified.
- The broad `OpenCode` public application-object facade is removed or deferred. Narrow primitives such as native tool construction and settlement types may be preserved or rehomed if tests or future extension substrate need them.
- `packages/opencode` remains quarantined, excluded from root workspaces, not build-gated, and retained only as TUI reference material for Milestone 4.
- Legacy opencode HTTP routes, handlers, server mounts, and session creation paths are removed from active routing or made unreachable. They are not compatibility fallbacks.

## Scope

### Rename Active Runtime Identity

Rename active package identities, imports, generated SDK names, service tags, comments, docs, local state paths, environment variables, and telemetry keys from OpenCode/opencode/V2 to GTE Agent.

Use:

- `gte-agent` for product and CLI binary naming.
- `@gte-agent/*` for active workspace package names.
- `GTE_AGENT_*` for environment variables.
- Neutral runtime names such as `Session`, `Event`, `RuntimeScope`, and related service tags instead of `SessionV2`, `EventV2`, and `Location`.

Do not preserve old aliases unless a concrete local development need is identified, documented at the call site, and kept out of public API, SDK, CLI, generated schema, and default runtime contracts.

### Remove V1 And Pre-Product Compatibility

Replace legacy V1 session compatibility in active `packages/core` runtime. Do not delete V1 creation/projection code until the canonical replacement exists and is covered by tests.

Milestone 2 must add:

- A canonical session-created event and event schema.
- A canonical session info schema that is not `SessionV1.SessionInfo`.
- A canonical SQLite persistence shape and projector path.
- Tests proving create, replay, projection, prompt admission, message replay, and list/history behavior through the canonical path.

The canonical create-session flow is:

```txt
POST /api/session -> canonical session.created event -> canonical session projection -> SDK/CLI-visible session response
```

After the canonical replacement exists, remove legacy V1 session compatibility from active `packages/core` runtime:

- No `SessionV1.Event.Created` as the canonical creation event.
- No V1 message/part projection compatibility in the canonical path.
- No tests whose only purpose is preserving historical V1 retry/projection behavior.
- No old OpenCode migration chain retained for compatibility.

This repo is pre-product and has no SQLite compatibility burden before MVP.

### Replace Location With Neutral Runtime Scope

Replace `Location` as active runtime vocabulary with a neutral runtime scope/context.

The runtime scope may carry only what the local skeleton still needs, such as a local directory for development persistence or model/tool execution where unavoidable. It must not invent GTE user, authority, market, account, or portfolio fields. Milestone 3 owns authority semantics.

Remove `workspace` from runtime/session/API concepts in Milestone 2. Do not replace it with authority yet.

Location/workspace removal must cover schema fields, API request and response payloads, service composition, runtime cache keys, route middleware, SQLite tables/indexes, SDK types, and default dependency wiring. A mechanical rename that preserves workspace placement semantics is not sufficient.

### Server, CLI, And SDK

Keep generic HTTP resource paths where already clean, such as `/api/session`.

Remove `v2` from:

- Server API group names and OpenAPI annotations.
- Handler/group directory names where practical.
- SDK generated namespaces and export paths.
- Client accessors such as `client.v2.*`.

Add the canonical create-session HTTP endpoint in Milestone 2 with a neutral runtime-scope payload and optional model/agent fields only if those remain part of the minimum skeleton.

`POST /api/session` is the canonical create-session endpoint. Legacy create-session routes must be removed from active routing or made unreachable. `packages/opencode` routes are reference-only and must not be mounted or imported by the active server.

Add explicit CLI acceptance for the local skeleton. The `gte-agent` CLI must be able to start or connect to the canonical server, create a session through `POST /api/session`, admit a prompt, stream deterministic model output, persist canonical events/messages, and replay or list local history.

Milestone 2 should define the active canonical route set instead of carrying every inherited V2 group forward. The minimum route set is:

- Health/status needed for local daemon discovery.
- `POST /api/session` for canonical session creation.
- `GET /api/session` for local session listing/history.
- `POST /api/session/:sessionID/prompt` for durable prompt admission.
- A canonical non-`v2`, non-`LocationQuery` session event stream endpoint for model/event streaming.
- Canonical non-`v2`, non-`LocationQuery` session message/history endpoints for replay.

Remove, defer, or explicitly justify any active agent, model, provider, permission, saved-permission, filesystem, command, skill, question, session-question, or event/message route group that is not part of this minimum canonical route set. Inherited V2 event/message routes may be mined for behavior, but they should not survive as hidden acceptance paths under V2 or Location-scoped contracts.

Update the JavaScript SDK generator inputs, output paths, generated client names, exports, and any codegen patches to emit canonical non-`v2` GTE Agent names before regeneration. Running the existing generator unchanged is not sufficient.

Regenerate the JavaScript SDK after server API rename and generator updates using:

```sh
./packages/sdk/js/script/build.ts
```

### Provider Bootstrap

Provider/model support remains only as policy-neutral generic LLM routing needed for the skeleton.

Milestone 2 acceptance must use a deterministic local mock/demo provider so the runnable skeleton does not depend on live credentials or external provider availability. Optional real-provider verification may be supported through explicit `GTE_AGENT_*` environment variables, but it is not the acceptance path.

Remove OpenCode-branded provider marketplace/catalog defaults, GitHub Copilot product assumptions, hosted-console provider policy, and public provider catalog behavior from the active runtime unless a concrete GTE-owned policy explicitly keeps a narrow piece as substrate.

### Tools And Extensions

Remove coding defaults from the active runtime:

- Filesystem search/read/write/edit/apply-patch defaults.
- Shell/bash defaults.
- Question, skill, todo, web fetch, and web search defaults.
- Coding LSP/Git/worktree/snapshot/revert/diff surfaces.
- Filesystem/search API routes.

Preserve typed tool registry and durable settlement as runtime substrate. Keep neutral test/demo tooling only where needed to prove the registry/settlement path. No current inherited built-in tool should remain advertised to the model by default through tool definition materialization.

Preserve plugin, MCP, command, and skill mechanisms, but disable inherited default loading. Future milestones must re-enable extension mechanisms only under explicit GTE policy, especially before any extension path can affect trading state.

Coding tools and extension loaders must be removed from default runtime composition, not only from HTTP routes. Keeping libraries as dormant substrate is allowed only when they are not auto-loaded, advertised to the model, mounted as HTTP routes, or reachable through default CLI/server startup.

### Public Native API

Remove or defer the broad `OpenCode` application-object facade from the active public API.

Do not replace it with a renamed GTE Agent application object during Milestone 2. That would prematurely design an embedding API while storage, runtime scope, auth, and extension policy are still changing.

Remove or defer public session/location facades and aliases that still expose `SessionV2`, `Location`, workspace, or V2-shaped contracts. Keep or rehome narrow public primitives only when they are real substrate and not tied to legacy session/location semantics, such as native tool construction and settlement types.

### Local Mock API/Auth Seam

Milestone 2 may add lightweight local mock API/auth seams if needed to keep the renamed skeleton testable while real GTE auth APIs are unavailable.

Do not implement principal/authority semantics in Milestone 2. Milestone 3 owns that contract.

## Out Of Scope

- GTE bearer-token validation or introspection.
- Principal/authority session binding.
- Trading tools, including read-only market/account tools.
- Market data, balances, positions, order preview, order submission, cancel/replace, risk checks, venue status, and execution audit.
- Trading memory.
- Real-liquidity execution semantics.
- Production GTE/server-side persistence.
- Final provider/model policy.
- TUI carve-out beyond quarantining `packages/opencode`.

## Implementation Checklist

1. Rename active workspace package identities to `@gte-agent/*` and CLI binary/product name to `gte-agent`.
2. Rename active imports, service tags, env vars, local paths, telemetry keys, and generated names away from OpenCode/opencode/lildax/V2.
3. Replace `Location` with neutral runtime scope/context across schema, API payloads, runtime composition, route middleware, SQLite tables/indexes, SDK types, service cache keys, and default dependency wiring.
4. Add canonical session-created event, canonical session info schema, canonical SQLite persistence shape, and canonical projector path.
5. Add canonical `POST /api/session` and route it through the canonical session-created event/projection path.
6. Remove V1 session compatibility after the canonical create/projection path is covered.
7. Replace old migrations with a clean pre-product SQLite baseline; do not preserve OpenCode/V1/workspace/share/account migration chains for compatibility.
8. Remove coding built-in defaults, filesystem/search/coding API routes, and coding tool availability from default runtime composition.
9. Disable inherited plugin/MCP/command/skill default loading while preserving mechanisms as dormant substrate.
10. Remove inherited question, skill, todo, web fetch, and web search tools from default model-advertised tool definitions.
11. Define the minimum canonical route allowlist and remove, defer, or justify every inherited route group outside it.
12. Add canonical non-`v2`, non-`LocationQuery` stream and message/history endpoints for CLI streaming and replay acceptance.
13. Add deterministic mock/demo provider support for skeleton acceptance and keep real-provider verification optional behind explicit GTE Agent env vars.
14. Remove/defer broad public application-object, session, and location facades; rehome narrow primitives only if needed and only when not tied to legacy session/location contracts.
15. Remove or make unreachable legacy opencode HTTP routes, handlers, server mounts, and session creation paths from the active runtime.
16. Rename server API groups, SDK generator inputs, SDK output paths, generated client names, exports, and codegen patches to canonical non-`v2` structure.
17. Regenerate JavaScript SDK.
18. Add explicit CLI session commands/callers for start/connect, create, prompt, stream, replay, and list/history against the canonical API.
19. Update docs and tests to reflect the clean GTE Agent runtime.
20. Verify the minimum runnable skeleton: CLI/server start, canonical session create through `POST /api/session`, prompt admission, deterministic mock/demo model stream, canonical SQLite persistence, and local replay/list history.

## Risks

- A mechanical rename that leaves `LocationServiceMap` semantics intact would preserve coding assumptions under new names. Runtime scope must be neutralized, not only renamed.
- Removing V1 compatibility requires replacing projection and tests with canonical equivalents, not leaving gaps in session history replay.
- Disabling coding tools can accidentally break the model loop if the runner assumes tool availability. The minimum skeleton should explicitly verify no-default-tool and neutral-demo-tool paths.
- SDK regeneration depends on server API rename and generator update order. Running the existing generator unchanged can preserve stale `v2` paths and OpenCode client names.
- Quarantined `packages/opencode` should not become an accidental active dependency during rename.
- Legacy routes may appear removed while still reachable through old mounts or imports. The active server should fail closed by not mounting them.
- Provider acceptance can become flaky if it depends on live credentials. M2 acceptance should use deterministic mock/demo output, with real providers optional.
- Leaving inherited support routes, public session/location facades, or model-advertised web/question/todo/skill tools active would preserve legacy runtime behavior even if the main session path is renamed.
