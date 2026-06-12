# Ultrathink Workflows — Adversarial Review & Integration Record

Final branch: `feat/ultrathink-workflows`. Base = candidate A (`feat/ultrathink-impl-a`, 602f61a53), grafts from candidate B (`feat/ultrathink-impl-b`, acc3e2cfc).

## Component verdict table

| Component | Winner | Why | Verified how |
|---|---|---|---|
| Script sandbox | **A** (Bun Worker) | Spec req #1 mandates an isolated Bun Worker. A strips Bun/process/require/fetch/WebSocket/XHR/EventSource/Worker/navigator (delete + frozen `undefined` + param shadowing) and statically rejects `import()`/`import.meta`. B runs in `node:vm` with host functions injected — trivially escapable via `log.constructor("return process")()` (B's own comment admits vm is not a boundary), and violates the Worker requirement. | Read both implementations; ran A's sandbox test (process/fetch/Bun undefined inside worker) |
| Run engine / pause-resume | **A** (`WorkflowRun`) | Generation-guarded worker teardown on pause; resume re-runs the script and replays completed agents from the (phase, prompt-hash) cache — exactly spec req #11. Per-agent stop/restart with attempt tracking (B has no per-agent stop/restart at all). | run.test.ts + new demo.test.ts (pause mid-run, ≤1 re-execution) |
| Server control routes | **A only** | `/experimental/workflow` list + `/experimental/workflow/:id/control` (pause/resume/cancel/stop-agent/restart-agent/save). B has none. | Read groups/handlers; route↔dialog action parity checked |
| TUI /workflows view | **A** | 4-level drill-in (runs→phases→agents→detail), all spec keybinds (↑↓ enter/→ esc/← p x r s) wired to the server routes; polls list route so pre-attach runs are visible. B's TUI literally toasts "Run control … is not wired to the server yet" and cannot see runs started before attach. | Read both; tui-plugin smoke test |
| /effort ultrathink | **B** | B integrates ultrathink into the *existing* variant system: `/effort` slash alias on the variants dialog, variant cycling (TUI + run CLI), persistence via `fitVariant`. A had a parallel one-off EffortDialog that duplicated the variants dialog and **was not hidden by the kill switch**. | Grafted; ultrathink.test.ts incl. cycling |
| Keyword detection | **B refinement on A** | B only matches non-synthetic user text parts; A matched synthetic parts too (could self-trigger from injected workflow results). Merged into `Workflow.hasKeyword`. | ultrathink.test.ts |
| workflow tool | **A** | Real subagent sessions via TaskPromptOps/Session/subagent-permissions, parent model/variant inheritance (model-agnostic), background completion injection, permission ask. B's tool similar but built on the weaker vm runtime. | Read; tool.test.ts |
| Saved workflows / registry | **A** | bundled < global < project precedence, frontmatter, name validation; registered as slash commands incl. bundled /deep-research. | registry.test.ts + new command.test.ts |
| Event protocol | **A** | Typed EventV2 (`workflow.run.started/updated/finished`, `phase.started/finished`, `agent.started/finished`, `log`) — covers spec req #12 (error = run.finished status:error). B's reducer/store design was elegant but only serves its own TUI. | Read schema.ts; demo test asserts event ordering |
| Tests | **Union** | A: 45 (registry/run/script/tool). Ported/adapted from B: ultrathink, command registration, tui-plugin smoke. New: spec demo.test.ts, sandbox-hardening validation tests. Final: 65 pass / 0 fail. B's engine/executor/store/schema tests were architecture-specific to the discarded vm engine — not portable. | `bun test test/workflow/` |

## False/inflated claims found

- **B claimed 73 workflow tests; actual is 59** (`bun test test/workflow/` in impl-b: 59 pass across 8 files).
- **B's TUI keybinds p/x/r are advertised in its dialog but show a "not wired to the server yet" toast** — pause/stop/restart did not work end-to-end in B.
- **B's "sandboxed worker" commit message** (2b56af663 "runtime core — sandboxed worker") — there is no Worker in B; it is `node:vm` in-process, escapable via `.constructor` traversal.
- A's claims held up under verification (45 tests real, routes real, sandbox real), with one gap: its EffortDialog ignored the kill switch (fixed here).

## What the final branch adds beyond either candidate

1. **Kill-switch completeness**: ultrathink effort option now hidden by BOTH `disableWorkflows` config and `GTE_AGENT_DISABLE_WORKFLOWS` (A missed config+env on its EffortDialog; B checked env only). Tool, /workflow command, saved-workflow commands, effort option all gated.
2. **Sandbox hardening**: script validation now also rejects `eval(`, `Function(`/`new Function`, `.constructor` access, and `globalThis` — closing the "smuggle `import()` inside a string through an indirect evaluator" class that A's static checks missed. Comment/string stripping prevents false positives on agent prompts.
3. **Single /effort surface**: removed A's duplicate EffortDialog; `/effort` aliases the variants dialog whose options append `ultrathink` (only when a high-effort variant exists to back it).
4. **Spec-required demo.test.ts** proving phases, concurrency cap, (phase,prompt) caching, pause/resume replay, total-agent cap, and event ordering against the real Bun-Worker runtime.

## Remaining gaps (human follow-up)

- **Sandbox is defense-in-depth, not a hard boundary.** Computed-string property access (e.g. `obj["const"+"ructor"]`) defeats static validation; a worker realm cannot fully revoke the Function intrinsic. A hard boundary needs a subprocess with OS-level restrictions or a loader hook denying dynamic import. Spec's stated bar (strip ambient capability from the script; agents do all I/O) is met.
- Server `/experimental/workflow` routes are not themselves gated by the kill switch (deliberate: lets you control still-running runs after flipping the config, and no runs exist when the tool is hidden) — confirm this is the desired semantics.
- `ULTRATHINK_INSTRUCTION` in `workflow/ultrathink.ts` is currently unused (the server uses `Workflow.ULTRATHINK_SYSTEM`/`KEYWORD_SYSTEM` via the system prompt path) — kept for reference, could be pruned.
- Saved-workflow args: the /workflow saved-command template asks the model to parse `$ARGUMENTS` into structured args; a stricter path would parse JSON before templating.
- TUI smoke-run of the full app was not performed (typecheck + plugin module-load test only), per spec's "say exactly what is verified vs not".
