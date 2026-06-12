# Milestone 9: Acceptance Record

Date: 2026-06-12
Branch: `feat/m9-self-authored-tools` (off `port/workflows-on-moses`, stacked on the Milestone 8 PR)
Scope: the six scope sections of `docs/m_9-self-authored-tools-plan.md`.

Verdict legend: PASS / PASS-WITH-NOTES / MANUAL-REMAINING / FAIL.

All automated evidence below was re-run on the recorded date against this branch. No automated test hits a real provider or search network: the sandbox, proxy, and registry behavior is proven against stub `gte_*` tools through the real worker and the real registry; the web tools' production wiring is proven by registry contribution, not live HTTP. Anything requiring real credentials or live endpoints is recorded as MANUAL-REMAINING.

## Per-Item Results

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | `websearch` and `webfetch` reach the model through the production registry | PASS | `packages/server/src/handlers.ts` (`webTools`, merged into `gteAgentHandlers` with FetchHttpClient + ToolOutputStore). Pinned by `packages/server/test/web-tools-registry.test.ts`, composed the same shape as the handlers. A live keyless Exa/Parallel search is MANUAL-REMAINING (network). |
| 2 | Shared sandbox primitives extracted with no behavior change | PASS | `packages/core/src/sandbox/hardening.ts` (banned globals, load-time `AsyncFunction` capture, constructor-prototype poisoning) and `sandbox/script-guard.ts` (strip + static checks + syntax check, message vocabulary parameterized). `WorkflowScript.validate` keeps its signature, error type, and exact messages; `test/workflow-script.test.ts` (14 cases) and `test/workflow-runtime.test.ts` pass unmodified, and the runtime tests spawn real workers, so the shared hardening is exercised end to end. |
| 3 | Definition schema, JSON-Schema projection, naming law | PASS | `packages/core/src/dynamic-tool/schema.ts`: flat `ParameterSpec` record (`string`/`number`/`boolean`, optional description/enum/required), top-level `type: "object"` projection with `additionalProperties: false`, `validName` (`^[a-z][a-z0-9_]{1,63}$`, `gte_` reserved), `validateCode` over the shared guard with Tool-code wording. `test/dynamic-tool-schema.test.ts`. |
| 4 | Saved-definition discovery and persistence | PASS | `packages/core/src/dynamic-tool/saved.ts`: JSON files, `~/.gte-agent/tools` (global, where creations write) then `.gte-agent/tools` (project) with project winning collisions; malformed JSON, invalid names, and invalid code skip with structured warnings; removal is global-only and tolerates missing files. `test/dynamic-tool-saved.test.ts`. |
| 5 | Sandboxed execution with the host-proxied `gte()` | PASS | `packages/core/src/dynamic-tool/{runtime,worker,protocol}.ts`: fresh worker per invocation behind the shared hardening, bindings `params` + `gte`; the host proxies `gte()` through `ToolRegistry.execute` under the calling session's identity, allowlisted to `gte_*` and capped (32 calls, 30s, both test-seamed via `layerWith`); worker terminated on settle, timeout, or interrupt. `test/dynamic-tool-runtime.test.ts` (8 cases through real workers: compute, proxy round trip, allowlist rejection, call cap, banned globals all `undefined`, timeout, thrown-error surfacing, JSON degradation). |
| 6 | `tool_workshop` create / remove / list | PASS | `packages/core/src/tool/tool-workshop.ts`: one scoped registry slot replayed on every mutation (other contributors untouched, removals fall out of the replay); create validates name/description/code, rejects claiming any existing non-dynamic tool, persists globally, contributes immediately (callable the same session — the registry resolves `definitions()`/`execute()` live); remove refuses repo-owned project files; workflow agents (child sessions) are rejected, mirroring the nested-workflow guard. `test/tool-workshop.test.ts` (11 cases, including a created tool surviving a fresh composition over the same directories — the restart path). |
| 7 | Kill switch | PASS | `packages/core/src/flag/flag.ts` (`GTE_AGENT_DISABLE_DYNAMIC_TOOLS`), `config/dynamic-tools.ts` + `dynamicTools` on `Config.Info`. Gated at tool contribution in `test/tool-workshop.test.ts` and at the production composition in `packages/server/test/tool-workshop-registry.test.ts` (flag, config, and default all asserted). |
| 8 | Production wiring | PASS | `packages/server/src/handlers.ts` (`toolWorkshop`, the workflow-tool wiring pattern: runtime + session store + config + scope + FSUtil/Global over the runner's `toolRegistry`). `packages/server/test/tool-workshop-registry.test.ts` composes the same shape. The workshop also joins `BuiltInTools.runtimeScopeLayer` for parity. |
| 9 | Cross-package sweep | PASS | See below. |

## Cross-Package Sweep (2026-06-12)

Run from package directories, never the repo root:

- `packages/core`: 1158 pass / 1 skip / 1 fail — the one failure is the pre-existing `Watcher > publishes .git/HEAD events` (macOS fs-events), failing identically before this branch.
- `packages/llm`: 303 pass / 28 skip / 0 fail.
- `packages/server`: 118 pass / 0 fail.
- `packages/tui`: 167 pass / 0 fail.
- `bun typecheck` clean in `packages/core`, `packages/server`, `packages/llm`, `packages/tui`, `packages/cli`, `packages/plugin`.

## Manual-Remaining

- A live provider turn in which the model creates a tool via `tool_workshop` and calls it on its next turn (token cost; the registry and worker path is fully covered by automation).
- A live keyless `websearch` call against the Exa/Parallel MCP endpoints from the production binary (network).

## Known Limitations (recorded, not silent)

Carried verbatim from the plan:

- Saved definitions are trusted at the file boundary (`~/.gte-agent/tools/*.json`), the same trust model as saved workflows.
- No TUI surface; dynamic tool calls render through the generic tool-call presentation.
- No per-tool success schemas; the result is the code's return value rendered as JSON text.
- Inner `gte()` calls do not settle durably per sub-call; the outer dynamic tool call settles like any tool call.
- The `gte()` allowlist is `gte_*` only; `websearch`/`webfetch` compose at the turn level, not inside tool code.
- The workshop's dynamic-name set is process-local (rebuilt from disk on boot), matching the workflow registry's process-local posture.
