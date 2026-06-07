# Milestone 1: Strip To Skeleton

This document is Milestone 1 of the GTE Agent retrofit. GTE Agent may be shortened to GTA in internal notes, but product/runtime wording should prefer GTE Agent.

Milestone 1 should remove, quarantine, or reclassify inherited opencode surfaces until the repo is a smaller skeleton for the trading runtime. It is one milestone of a larger project, not the full GTE Agent plan.

Later milestones should cover trading tools, trading memory, GTE auth, server-side persistence, TUI redesign, real execution policy, risk gates, and audit/reporting semantics. Do not design those here.

## Milestone Goal

After Milestone 1, the repo should still have enough substrate to run a local/dev GTE Agent skeleton:

- Canonical session/event runtime.
- Typed tool and permission primitives.
- LLM request/stream execution.
- Local SQLite for dev/test/local persistence.
- Server/API/SDK/CLI entrypoint path pointed at the canonical runtime.
- TUI experience or carve-out path.
- Plugin/MCP/command/skill mechanisms for future GTE-owned policy.
- Internal planning docs and one temporary English README.

It should not still carry inherited OpenCode product surfaces that make the target shape ambiguous.

## Guiding Principles

Prefer the newer core/runtime path.

GTE Agent should converge around the architecture currently described as V2. In GTE Agent, this should become the default runtime and should not retain "V2" naming in product-facing or long-term internal vocabulary.

Strip product surfaces, not useful substrate.

If a feature exists only because opencode is a coding product, it should be removed. If it is a general runtime primitive, keep or rework it only after naming the boundary clearly.

Prove deletion boundaries.

Before removing a package or subsystem, trace workspace entries, package dependencies, root scripts, generated SDK/OpenAPI output, tests, docs, env vars, CI workflows, release scripts, and runtime imports. Deletion is clean only when those references are removed, rewritten, or deliberately carved out.

Do not design the trading domain too early.

This milestone should make room for GTE Agent. It should not pretend to have solved the tool catalog, memory system, real-liquidity execution semantics, or GTE persistence schema.

Prefer GTE-owned authority.

Auth, account authority, persistence, model policy, extension policy, and execution policy should be GTE-owned in the final shape.

## Canonical Runtime First

Before broad deletion, define the core runtime seam:

- Session create/admit/prompt/resume.
- Durable event publication and replay.
- Typed tool registration and settlement.
- Permission/approval boundary.
- LLM request/stream boundary.
- Runtime context formerly represented by opencode `Location`.
- Local persistence boundary.
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
- `packages/effect-drizzle-sqlite` and `packages/effect-sqlite-node`, if they remain useful for local/dev/test SQLite
- `packages/http-recorder`, if it remains useful for tests

Likely legacy/quarantine areas:

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- Legacy V1 message/part hydration paths.
- Legacy opencode HTTP session handlers that still call the old session loop.
- Legacy coding tool defaults.
- `packages/core/src/v1` and config compatibility once the canonical runtime has a replacement.

## Remove Completely

These are target removals for Milestone 1 once dependency boundaries are proven.

### Browser UI

Remove browser UI surfaces:

- `packages/app`
- Browser app routes, stores, file panels, review/diff UI, terminal panels, and project/worktree launcher flows.
- Browser-only server selection and event-sync UI.
- App e2e tests, browser fixtures, i18n strings, and docs that exist only for this UI.

Reason: the final package should not ship UI components except the TUI.

### Web / Docs Product / Share

Remove:

- `packages/web`
- `packages/docs`
- Public docs site and Mintlify/SDK docs starter.
- Marketing/docs web app surfaces.
- Localized web docs and i18n content.
- Public session sharing pages and polling.

Reason: the root `docs/` folder is retained for internal retrofit planning and is distinct from the old product docs package. Product docs should be rebuilt later after GTE Agent naming, install, auth, and runtime shape stabilize.

### Public Share Subsystem

Remove public sharing as a whole subsystem, not only the hosted page:

- Local share state such as `session_share`, `share_url`, and share projection/schema fields.
- Share create/sync/delete logic under opencode share modules.
- Share API routes, handlers, generated OpenAPI, and SDK `share`/`unshare` methods.
- CLI, TUI, browser, and command surfaces such as `/share`, `/unshare`, `run --share`, import-from-share, keybinds, and session headers.
- Config flags and env vars such as auto-share defaults.
- Enterprise share routes, object-storage snapshots/events/data, and public share rendering.
- Web `/s/:id` pages, console share proxies, share polling, and share components.
- Slack and GitHub action paths that create or auto-share sessions.
- Share tests, fixtures, docs, localized docs, and SDK examples.

Reason: trading sessions can contain account-sensitive, execution-sensitive, and compliance-sensitive material. If a sharing concept returns later, it should be a fresh authenticated, redacted, audited design, not inherited public secret-link snapshots.

Representative surfaces to trace:

- `packages/opencode/src/share`
- `packages/core/src/share`
- `packages/core/src/session/sql.ts`
- `packages/opencode/src/server/routes/instance/httpapi`
- `packages/sdk/openapi.json`
- `packages/enterprise/src/core/share.ts`
- `packages/enterprise/src/routes/share`
- `packages/web/src/pages/s`
- `packages/web/src/components/Share.tsx`
- `packages/console/app/src/routes/s`
- `packages/slack`
- GitHub action run/share paths.

### Desktop

Remove:

- `packages/desktop`
- Electron sidecar behavior.
- Desktop updater/distribution assets.
- Desktop install docs, release workflows, and root README references.

Reason: desktop depends on older opencode sidecar/server paths and is not part of the target package shape.

### Storybook And Browser UI Support

Remove:

- `packages/storybook`
- Browser UI story/test scaffolding tied to stripped components.
- Shared UI pieces that exist only for browser app/storybook surfaces.

Reason: the only retained UI surface should be TUI. `packages/ui` should be removed by default with browser/storybook surfaces unless a concrete TUI dependency is proven and carved out.

### VS Code / Editor Extension

Remove:

- `sdks/vscode`
- Publish workflows, docs, package metadata, and generated references tied to the extension.

Reason: it is a terminal-oriented opencode extension, not a GTE Agent runtime surface.

### Remote Workspace / Control Plane Sync

Remove:

- Remote workspace/worktree routing.
- Workspace sync/replay/steal semantics.
- Coding-workspace adapters.
- Workspace/org assumptions in session authority.
- Control-plane docs, tests, and developer workflows tied to coding workspaces.

Reason: opencode's remote workspace model is coding-specific and should not become GTE Agent infrastructure. GTE Agent cross-entrypoint continuity should come from GTE/server-side sessions, not workspace/worktree sync.

### Hosted OpenCode Product

Remove after proving clean deletion:

- `packages/console`
- `packages/stats`
- `packages/slack`
- Hosted console account/org/workspace flows.
- Stats dashboards, analytics ingest, app/server/core packages, and docs.
- Slack integration flows and share/session coupling.
- Hosted product tests, env/config, resources, mail/support packages, and deployment hooks.

Reason: these are OpenCode hosted product surfaces. GTE Agent has no org/workspace axis in the initial session model. Any reusable auth, billing, provider, or infra substrate must be explicitly identified and carved out before deletion.

### GitHub Action / Release / Automation

Remove or rewrite OpenCode-specific automation:

- `github`
- `.github/workflows` that publish, release, deploy, sync docs locales, publish VS Code, publish desktop, deploy Storybook/docs/web/containers/stats, manage OpenCode issues, or enforce OpenCode product workflows.
- Root scripts that start old app/storybook/desktop/console/stats surfaces.
- Publish/release scripts under `script` and package-local scripts that only serve removed surfaces.
- OpenCode package names, binary names, repository URLs, release metadata, and badges.
- `infra`, `nix`, `packages/containers`, and other deployment/build surfaces that only exist for removed OpenCode products.

Reason: package deletion is incomplete if old CI, release, and distribution machinery still points at removed products.

### Product Documentation And Localization

Collapse docs to one temporary English README plus internal planning docs:

- Remove translated root READMEs such as `README.*.md`.
- Rewrite root `README.md` as temporary GTE Agent skeleton documentation.
- Remove localized web docs, root OpenCode install/product docs, desktop install docs, share docs, provider marketplace docs, VS Code docs, Slack/GitHub action docs, and package docs deleted with their packages.
- Remove `.opencode/glossary` and translation commands/workflows.
- Remove docs-locale sync automation.

Reason: stale translations and product docs multiply every rename and preserve removed OpenCode product assumptions. Localization should return only after GTE Agent product docs exist.

### Historical Specs And Migration Plans

Inherited specs are not active GTE Agent guidance by default:

- `specs/v2`
- `specs/storage`
- `packages/opencode/specs`
- package-level migration plans and old effect/test specs

For each spec, either:

- Delete it with the package/subsystem it describes.
- Move or label it as historical opencode context.
- Promote the useful content into `docs/` as GTE Agent planning material.

Reason: old V2/opencode specs can be useful context, but they conflict with the goal that the newer runtime becomes the only runtime and should no longer be called V2.

## Keep Or Rework

### TUI

Keep the TUI experience as the only UI surface, but align it to the canonical runtime.

Current state:

- The interactive surface is embedded under `packages/opencode/src/cli`.
- The newer `packages/cli` is a server/daemon CLI, not the TUI.
- The current TUI is entangled with legacy sessions, share, sync, filesystem tools, server routes, package naming, and OpenCode defaults.

Target:

- A TUI package/surface that talks to the canonical GTE Agent runtime.
- Old TUI code can be mined for interaction patterns.
- Do not preserve old session/tool/filesystem/share/sync assumptions by default.
- Do not treat `packages/opencode` as a keeper package merely because it contains TUI code.

### CLI / API / SDK

Keep CLI/API/SDK as runtime entrypoints, with cleanup:

- CLI should start/connect to the canonical runtime.
- API should expose the canonical runtime, without V2 naming.
- SDK should generate from the canonical server API, not stale older opencode OpenAPI paths.
- Remove share endpoints, workspace/sync endpoints, browser-app assumptions, and legacy session paths from generated contracts.
- Resolve binary/name mismatches such as `lildax`, `opencode`, and future GTE Agent naming.

### Local SQLite

Keep SQLite as local/dev/test substrate.

Current opencode uses SQLite as local durable storage for sessions, messages, todos, event rows, session inputs, projections, context epochs, and share metadata. It also runs local HTTP servers and daemon flows against that storage.

Target:

- GTE/server-side persistence is production-canonical.
- SQLite can remain for local development, tests, and temporary skeleton operation.
- Remove or migrate schema assumptions tied to project/workspace/share/V1 history.
- Do not let local SQLite define the final production ownership or cross-entrypoint access model.

### Generic LLM Runtime

Keep:

- Canonical LLM request/stream abstraction.
- Provider integration as a runtime capability.

Rework:

- Provider/model selection policy should be GTE-owned.
- Strip opencode's provider marketplace, hosted-console provider config, public provider catalog, GitHub Copilot-specific product assumptions, and product docs unless GTE later chooses them.

### Typed Tools

Keep the typed tool registry and durable settlement model.

Rework:

- Coding built-ins should not be default GTE Agent tools.
- Trading mutation tools must be first-class typed tools with explicit authorization and audit semantics.
- Plugin/MCP tools can remain future extension mechanisms, but not as uncontrolled routes to trading mutation.

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

### Plugin / MCP / Commands / Skills

Keep extension mechanisms, but prune inherited content.

Target:

- Preserve the ability to have plugins, MCP integration, commands, and skills in the future.
- Remove or rewrite OpenCode-specific defaults, fixtures, docs, and examples that assume coding workspaces, shell/file mutation, GitHub workflows, or public sharing.
- Add GTE-owned policy before any extension path can perform trading mutation.
- Do not delete the mechanism just because current content is coding-oriented.

### Support Packages

Classify support packages explicitly:

- Keep or rework `packages/script` if it remains useful for repository tooling.
- Keep or rework `packages/http-recorder` if it remains useful for tests.
- Keep SQLite wrapper packages if local/dev/test persistence remains.
- Rework or remove `packages/function`, `packages/containers`, `packages/identity`, `infra`, and `nix` based on whether they support the skeleton or removed OpenCode products.

## Coding Tool Classification

Do not remove every tool blindly. Classify later:

- Remove if the tool is only useful for coding.
- Keep or rework if the tool is a general agent/runtime primitive.
- Defer if the tool is unclear or coupled to a future TUI/runtime decision.

Likely coding-specific removals from default GTE Agent:

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
- Plugin/MCP/command/skill mechanisms under GTE policy.

This classification is intentionally deferred. The barebones shape comes first.

## Auth And Account Scope

Target:

- Auth through GTE login.
- No org/workspace axis in the initial model.
- One session binds to one authenticated GTE trading authority for its lifetime.

Implications:

- Replace Basic auth.
- Remove or quarantine opencode hosted-console account/org/workspace assumptions.
- Replace local-only server password semantics for production.
- Tool execution authority must derive from the authenticated GTE trading authority.
- Do not assume whether the authority is ultimately represented as a user, subaccount, wallet, portfolio, venue account, or entitlement scope.

Unresolved:

- Exact GTE login protocol.
- Token refresh/storage.
- Session ownership enforcement.
- Trading account entitlement checks.

## Persistence

Target:

- GTE/server-side persistence is canonical for production and cross-entrypoint continuity.
- Local SQLite remains useful for local development, tests, and temporary skeleton runtime.

Keep as substrate:

- Durable event concepts.
- Session input admission.
- Projected read models.
- Event replay.
- SQLite wrappers if they keep tests and local development productive.

Rework:

- Storage location and ownership.
- Database schema naming.
- Project/workspace/share/V1 fields.
- Cross-entrypoint access model.
- Recovery semantics for real trading execution.

## Runtime Context Replacement

Current opencode `Location` is directory/project/workspace oriented.

GTE Agent rough target shape:

- GTE user identity.
- Authenticated GTE trading authority.
- Market/trading context.

This is not final. It is a placeholder for future design. The important strip-plan decision is to preserve the scoped service composition pattern while removing filesystem/workspace semantics from the core product model.

`packages/core/src/location-layer.ts` needs decomposition, not just renaming: preserve scoped service composition while removing filesystem, project, workspace, shell, ripgrep, command/skill config, and coding-tool contents from the default product runtime.

## Deferred Decisions

These should be tracked but not specced in Milestone 1:

- Trading tool catalog.
- Trading memory.
- Real order execution design.
- Order idempotency and retry policy.
- Partial fill/cancel/replace semantics.
- Post-crash ambiguity and recovery.
- Exact TUI information architecture.
- Provider/model policy.
- Final plugin/MCP/command/skill policy.
- Audit log shape for model output, tool input, approvals, order payloads, venue responses, and cancellations.
- Any future sharing/export/audit-report design.

## Milestone 1 Checklist

1. Name the canonical runtime seam.
   Remove V2 terminology from the target architecture and make the newer runtime the only supported path.

2. Inventory packages and surfaces.
   For each package and top-level support directory, mark keep, remove, rework, or defer.

3. Prove clean deletion boundaries.
   Trace imports, workspace entries, root scripts, package scripts, tests, docs, generated SDK/OpenAPI output, env vars, CI workflows, release scripts, and runtime routes before deletion.

4. Strip decided product surfaces.
   Start with browser app, desktop, Storybook, VS Code extension, public share, web/docs product, localization, hosted OpenCode product, Slack, stats, GitHub action/release automation, and remote workspace/control-plane sync.

5. Preserve runtime substrate.
   Keep sessions, events, typed tools, permissions, context epochs, LLM runtime, local SQLite, server/API/SDK/CLI path, extension mechanisms, and TUI carve-out path.

6. Rewrite docs.
   Collapse public docs to one temporary English README plus internal `docs/` planning docs. Remove or historical-label inherited specs not promoted into GTE Agent docs.

7. Verify skeleton health.
   After implementation, the skeleton should still be able to run local/dev runtime flows for sessions, model calls, streaming, local persistence, and retained primitives, even though it will not yet be production trading software.
