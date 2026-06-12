# Milestone 9 — Self-Authored Tools (Tool Workshop)

## Goal

Give the GTE agent the ability to extend its own tool surface at runtime: the model authors a small, schema-described tool (a JavaScript function over the read-only GTE data tools), the runtime persists it, and the tool becomes callable on the next provider turn — no rebuild, no restart. Alongside it, close a production gap found while scoping this milestone: the `websearch` and `webfetch` tools are fully implemented and tested in core but were never composed into the production tool registry, so the running agent cannot search the web at all.

The shape follows the same philosophy as Milestone 8's workflows: the model writes a small script, the script runs in a hardened sandbox with a minimal injected API, and everything the script can actually *do* flows through the existing tool/permission machinery. Where a workflow script coordinates agents, a dynamic tool composes read-only GTE data calls into a reusable, named, schema-described capability.

## End State

After Milestone 9:

- The production session runner advertises `websearch` and `webfetch` alongside the `gte_*` tools and `workflow`. Both were already implemented, tested, and composed into `BuiltInTools.runtimeScopeLayer` — which the server never builds. They are now wired into the server handlers' registry the same way the workflow tool was in Milestone 8's fix-list item 1. `websearch` works keyless (provider chosen per session); `EXA_API_KEY` / `PARALLEL_API_KEY` and the `GTE_AGENT_ENABLE_EXA` / `GTE_AGENT_ENABLE_PARALLEL` / `GTE_AGENT_WEBSEARCH_PROVIDER` env contract are unchanged.
- A `tool_workshop` tool exists (named for the openclaw `skill_workshop` precedent). `action: "create"` registers a new tool from `{ name, description, parameters, code }`; `action: "remove"` retires one; `action: "list"` reports every dynamic tool with its scope and source file.
- A created tool is immediately contributed to the live tool registry — the registry resolves `definitions()` and `execute()` at call time, so the model can call its new tool on the next turn of the same session.
- Definitions persist as JSON files: creations write `~/.gte-agent/tools/<name>.json`; discovery also reads `.gte-agent/tools/*.json` in the project (project wins name collisions, mirroring saved workflows). On boot the layer re-discovers and re-contributes every valid saved tool; invalid files are skipped with a structured warning, never a crash.
- Dynamic tool code executes in a dedicated Bun Worker with the same hardening as the workflow sandbox — the shared hardening (banned globals, function-constructor poisoning) and the shared static script guard are extracted into `packages/core/src/sandbox/` and used by both workers. The only bindings in scope are `params` (the decoded call arguments) and `gte(name, args)`, a host-proxied call into the same `ToolRegistry.execute` path the model itself uses, allowlisted to `gte_*` read-only data tools and capped (32 calls, 30s wall clock per invocation, fresh worker per call).
- Names are governed: a dynamic tool name must match `^[a-z][a-z0-9_]{1,63}$`, must not start with `gte_`, and must not claim any existing non-dynamic registry entry. Removal only touches tools the workshop owns.
- Workflow agents (child sessions) cannot create or remove tools, mirroring the nested-workflow guard: fan-out agents must not mutate the shared registry.
- `GTE_AGENT_DISABLE_DYNAMIC_TOOLS=1` (flag) or `dynamicTools: { enabled: false }` (config) hides the workshop and stops saved-tool contribution, exactly like the workflows kill switch.
- All existing suites stay green from package dirs; new behavior is covered by tests in the owning packages.

## Scope

### 1. Production web tools wiring (`packages/server`)

`WebSearchTool.layer` (with its `defaultConfigLayer` env contract) and `WebFetchTool.layer` compose into the same `toolRegistry` the session runner advertises, provided `FetchHttpClient` and `ToolOutputStore.defaultLayer`. This is the workflow-tool production wiring pattern; the server test that pinned that fix gains the same assertions for `websearch` and `webfetch`.

### 2. Shared sandbox primitives (`packages/core/src/sandbox/`)

Extraction only — no behavior change:

- `hardening.ts`: `BANNED_GLOBALS`, the module-load `AsyncFunction` capture, and `sanitize()` move out of `workflow/worker.ts`; both workers import them. The capture-before-poison ordering is preserved by module-load semantics.
- `script-guard.ts`: the static validation core of `workflow/script.ts` (strip comments/strings, reject `import`/`export`/`eval`/`Function`/`.constructor`/`globalThis`, syntax-check via `AsyncFunction` construction) generalizes over the injected binding names and the error-message subject. `WorkflowScript.validate` keeps its public signature and error type, delegating to the shared guard.

### 3. Dynamic tool definition + persistence (`packages/core/src/dynamic-tool/`)

- `schema.ts`: the `Definition` schema — `name`, `description`, `parameters` (a flat record of `{ type: "string" | "number" | "boolean", description?, enum?, required? }`), `code` — plus `validName` and the JSON-Schema projection for the provider wire (`type: "object"`, `properties`, `required`, `additionalProperties: false`). Parameters are structured data, which is why definitions are JSON files rather than the `.mjs`-with-frontmatter format saved workflows use: a comment block cannot carry a schema faithfully.
- `saved.ts`: discovery and persistence mirroring `workflow/saved.ts` — `~/.gte-agent/tools` (global) then `.gte-agent/tools` (project), project wins, invalid files skipped with a warning. Writes always target the global directory; project files are repo-owned and the workshop refuses to remove them.

### 4. Sandbox runtime (`packages/core/src/dynamic-tool/runtime.ts`, `worker.ts`, `protocol.ts`)

- The worker evaluates `code` as the body of an async function whose only bindings are `params` and `gte`, after the shared `sanitize()` pass. `gte(name, args)` posts to the host and awaits the result; the resolved return value of the body is the tool result (JSON-clonable values only, degrading like workflow results).
- The host (`DynamicToolRuntime`) spawns one worker per invocation, proxies `gte` messages through `ToolRegistry.execute` with the calling session's identity (so address-fallback and the permission regime behave exactly as a direct model call), enforces the `gte_*` allowlist and the call/time caps, and terminates the worker on settle, timeout, or interrupt.
- `enabled` reads the kill switch (flag + `dynamicTools.enabled`), mirroring `WorkflowRuntime.enabled`.

### 5. Workshop tool (`packages/core/src/tool/tool-workshop.ts`)

- Flat parameters (`action`, then optional `name` / `description` / `parameters` / `code` validated per action) — a top-level union would not survive the providers' `type: "object"` requirement.
- `create`: decode the definition, run the shared script guard over `code`, enforce the naming law against the live registry, persist globally, contribute the tool entry. Contribution builds the entry with `Tool.make`'s dynamic `jsonSchema` mode (the mode that exists for schemas not known at compile time) and an execute closure that asserts permission under the dynamic tool's own name and delegates to the runtime.
- `remove`: only names the workshop contributed; deletes the global file and the registry entry.
- `list`: every dynamic tool with name, description, scope, and file.
- The layer contributes nothing when the kill switch is off; on build it discovers saved definitions and contributes each plus the workshop itself. The workshop also registers into `BuiltInTools.runtimeScopeLayer` for parity, and into the production handlers' registry following the workflow-tool wiring.

### 6. Config + flag (`packages/core`)

`config/dynamic-tools.ts` (`ConfigDynamicTools.Info` with `enabled`), a `dynamicTools` field on `Config.Info`, and a `GTE_AGENT_DISABLE_DYNAMIC_TOOLS` getter on `Flag`.

## Security posture

Same statement as Milestone 8, deliberately: defense in depth, not a hard security boundary. The static guard and worker hardening close the escape routes the M8 adversarial review found (template-interpolation `import()`, computed `.constructor`); everything a dynamic tool can actually reach flows through `ToolRegistry.execute` under the calling session's identity, and the proxy allowlist confines that to the read-only `gte_*` surface. A dynamic tool can therefore read public market/account data and compute — nothing else. No filesystem, no network, no shell, no workflow spawning, no recursive workshop access from inside tool code.

## Known limitations (recorded, not silent)

- Tool definitions are trusted at the file boundary: a user who hand-edits `~/.gte-agent/tools/*.json` is editing their own agent's capabilities, same trust model as saved workflows.
- No TUI surface this milestone; dynamic tool calls render through the generic tool-call presentation. A `/tools` overlay can follow the `/workflows` pattern later if wanted.
- No success schemas for dynamic tools: the result is the script's return value rendered as JSON text. Output schemas would need per-tool maintenance the model cannot be trusted to keep honest yet.
- The `gte()` proxy synthesizes registry calls with worker-local call IDs; durable per-subcall settlement (transcript rows per inner `gte_*` call) is not part of this milestone — the outer dynamic tool call settles durably like any tool call.
- `websearch`/`webfetch` are not callable from dynamic tool code (allowlist is `gte_*` only); the model composes them itself at the turn level.
