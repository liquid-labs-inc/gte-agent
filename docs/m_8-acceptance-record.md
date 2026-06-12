# Milestone 8: Acceptance Record

Date: 2026-06-12
Branch: `port/workflows-on-moses` (off `initial-skeleton`)
Scope: Implementation Checklist items 1–15 of `docs/m_8-dynamic-workflows-plan.md`.

Verdict legend: PASS / PASS-WITH-NOTES / MANUAL-REMAINING / FAIL.

All automated evidence below was re-run on the recorded date against the coalesced branch. No automated test hits a real provider network: the agent executor's end-to-end coverage runs under the central `GTE_AGENT_LLM=demo` preload, and the LLM protocol changes are verified by prepared-request-body assertions, not live calls. Everything requiring real credentials — a live Fable 5 adaptive-thinking turn, a live workflow fan-out against a real model — is honestly recorded as MANUAL-REMAINING under item 14.

## Per-Item Results

| #  | Item | Verdict | Evidence |
|----|------|---------|----------|
| 1  | Anthropic adaptive thinking (`{ type: "adaptive" }`, `display: "summarized"` for Fable 5 / Opus 4.7+); legacy `enabled` path unchanged | PASS | `packages/llm/src/protocols/anthropic-messages.ts`; tests in `packages/llm/test/provider/anthropic-messages.test.ts` (fable adaptive+summarized, opus-4-8 adaptive+summarized, sonnet adaptive without display, legacy `enabled` byte-identical, invalid thinking rejected). `bun test` in `packages/llm`: 275 pass / 28 skip. |
| 2  | Curated reasoning-effort variants on the four Anthropic models | PASS | `packages/core/src/catalog-curated.ts`: Fable 5 + Opus 4.8 → `low/medium/high/xhigh/max` adaptive; Sonnet 4.6 → `low/medium/high/max` adaptive (no `xhigh`, no display override, matching upstream); Haiku 4.5 → `high/max` legacy budgeted. `test/catalog-curated.test.ts` asserts exact ids+bodies; OpenAI models carry no variants. |
| 3  | Session runner merges the selected variant's thinking payload; unknown variant is a visible error | PASS | `packages/core/src/session/runner/model.ts` (`UnknownVariantError`), `runner/llm.ts` (providerOptions merge; no variant ⇒ no thinking key). `test/session-runner-model.test.ts`, `session-runner.test.ts`, `session-runner-model-auth.test.ts`. |
| 4  | Run/phase/agent snapshot schemas + script validation rejecting `import`/`eval`/`Function`/`.constructor`/`globalThis` (incl. template interpolation) | PASS | `packages/core/src/workflow/schema.ts`, `script.ts`. `test/workflow-script.test.ts` (14 cases). |
| 5  | Worker host injects `phase`/`agent`/`map`/`log`/`args` and strips `Bun`/`process`/`require`/`fetch`/`postMessage`/`self`; computed `.constructor` escape closed | PASS | `packages/core/src/workflow/worker.ts`. Sandbox proof in `test/workflow-runtime.test.ts` (11 globals `undefined`; computed-`.constructor` escape blocked by prototype poison). Independently re-verified by differential probe: the `node:os` hostname-leak payload escapes on the pre-fix tree and is blocked post-fix. |
| 6  | Runtime: phase grouping, `map` concurrency bound, 16/1000 caps, pause/resume result caching, result delivery, error propagation | PASS | `packages/core/src/workflow/runtime.ts`. `test/workflow-runtime.test.ts`: cap formula, concurrency-bound proof (peak == 2), 1000 backstop, cache-hit on resume, stop, error propagation. |
| 7  | Agent executor over child sessions with parent scope + authority; unavailable model/variant falls back to the parent model, visibly | PASS | `packages/core/src/workflow/executor.ts`. `test/workflow-executor.test.ts` (incl. a default-model session surfacing a requested variant + fallback, never silent). Two-phase e2e under `GTE_AGENT_LLM=demo`. |
| 8  | `workflow` tool: params, synchronous settlement, `background: true` via `BackgroundJob`, script persisted to disk | PASS | `packages/core/src/tool/workflow.ts`. `test/tool-workflow.test.ts`; production wiring proven by `packages/server/test/workflow-tool-registry.test.ts` (tool reaches the runner's registry iff enabled). |
| 9  | Durable `started`/`finished` + ephemeral `updated` snapshot events; server `WorkflowGroup` list/get/control routes | PASS | `packages/core/src/workflow/event.ts`, `session/event.ts`; `packages/server/src/groups/workflow.ts`, `handlers/workflow.ts`, `live-session-events.ts`. SSE snapshot times wire-encoded to millis. `packages/server/test/httpapi-exercise/workflow.test.ts`, `workflow-disabled.test.ts`, `live-session-events.test.ts`. `bun test` in `packages/server`: 114 pass. |
| 10 | `/workflows` overlay (list → two-panel run view → agent detail), pause/stop keybinds, live indicator | PASS | `packages/tui/src/ui/workflows-overlay.tsx`, `state/workflows.ts`. `test/workflows-overlay.test.tsx`, `workflows-state.test.ts`. Active-run line is reactive (`createMemo`); the open-time kill-switch probe reports disabled rather than an empty overlay. |
| 11 | `/effort` incl. `ultrathink`; status-bar variant display; orchestration instruction | PASS-WITH-NOTES | `packages/tui/src/commands/slash.ts`, `state/effort.ts`, `ui/status-bar.tsx`; core `session/runner/system-prompt.ts`. `/effort <tier>` re-selects the variant with up-front validation; `/effort ultrathink` resolves the highest variant (`xhigh`→`max`→`high`). NOTE: the ultrathink "intent" is session-local — the TUI prepends the `ultrathink` keyword to subsequent prompts, feeding the server-side keyword detector — rather than a durable session-schema flag. This is consistent with the milestone's process-local posture; a durable session-intent column is the upgrade slot. |
| 12 | Saved-workflow discovery (project over global), frontmatter, bundled `/deep-research` | PASS-WITH-NOTES | `packages/core/src/workflow/saved.ts`, `plugin/workflow-command.ts`, bundled `deep-research` script. `test/workflow-saved.test.ts`, `test/plugin/workflow-command.test.ts`; the bundled script passes `WorkflowScript.validate()` and was run end-to-end through the runtime (hardened against malformed model output and a dropped verifier). `/deep-research` is reachable as a first-class TUI slash command. NOTE: arbitrary saved `.mjs` files register into the core `Command` registry but are not yet exposed to clients — the command-plugin boot path is dormant in the base (identical to `ConfigCommandPlugin`); live exposure of user `.mjs` workflows lands with that boot wiring. |
| 13 | Kill switch (`GTE_AGENT_DISABLE_WORKFLOWS` / `workflows.enabled`) gates the tool, commands, routes, effort option, and the keyword instruction | PASS | `packages/core/src/flag/flag.ts`, `config/workflows.ts`. Gates verified at: tool contribution (`workflow-tool-registry.test.ts`), saved commands (`plugin/workflow-command.test.ts`), routes (`workflow-disabled.test.ts`), the keyword instruction (`session-runner-system-prompt.test.ts`, disabled + keyword ⇒ no instruction), and `/effort ultrathink` / `/workflow` (`slash.test.ts`). |
| 14 | End-to-end demo workflow run | PASS (demo) / MANUAL-REMAINING (live model) | `test/workflow-executor.test.ts` runs a two-phase fan-out through tool → runtime → worker → child sessions under `GTE_AGENT_LLM=demo`, with durable `started`/`finished` replayed from `Session.events`. A live run against a real model (token cost, real adaptive thinking) is MANUAL-REMAINING. |
| 15 | Cross-package sweep recorded | PASS | See below. |

## Cross-Package Sweep

Re-run on 2026-06-12 against `port/workflows-on-moses` (from package dirs; the root guard forbids `bun test` at the root):

- `packages/core`: **1128 pass / 1 skip / 1 fail**. The single failure is the pre-existing `Watcher > publishes .git/HEAD events` (macOS fs-events; fails identically on the untouched baseline, carried forward from M6/M7). +33 tests vs the M7 baseline of 1052.
- `packages/llm`: **275 pass / 28 skip / 0 fail**.
- `packages/server`: **114 pass / 0 fail** (M7 baseline 99; +15).
- `packages/tui`: **167 pass / 0 fail** (M7 baseline 125; +42).
- `bun turbo typecheck`: 11/11 packages pass.
- `bun run lint`: 0 errors (807 warnings, all pre-existing classes — no new error types introduced).
- `bun run audit:gte`: passed (713 files). The read-only GTE data boundary is untouched; workflow agents see exactly the tool surface any session sees.

## Adversarial Review And Fix-Pass

This milestone was built by parallel implementation agents (LLM/effort foundation; two competing workflow-runtime cores; server, TUI, and orchestration surfaces), then audited by three independent reviewers (core correctness, TUI↔server↔core integration, user-facing surfaces). The review found and the subsequent fix-pass closed:

- A real sandbox escape: computed `.constructor` access (`map["cons" + "tructor"]("return import('node:os')")()`) bypassed the literal-only validator and reached `node:os`. Closed by poisoning `constructor` to `undefined` on the four function-constructor prototypes inside the worker sanitizer; re-verified by a differential probe (escapes pre-fix, blocked post-fix).
- Live `/workflows` elapsed columns rendering `NaN` because SSE snapshots serialized `DateTime` as ISO strings while the TUI expected millis — fixed by wire-encoding the snapshot event.
- The models catalog not exposing per-model `variants`, leaving `/effort` unable to resolve any reasoning tier — fixed server-side.
- Unvalidated variant selection that would persist a dangling variant and fail every subsequent turn — fixed by validating against the model's catalog variants at selection time.
- The `ultrathink` keyword instruction escaping the kill switch — fixed by gating the system-prompt part on the runtime enable check.

The competing-cores selection (the runtime that shipped vs. the one that did not) turned on exactly this kind of finding: the rejected candidate carried a sandbox escape of the same class via template-literal interpolation.

## Known Limitations Carried Forward

1. Pre-existing core test failure `Watcher > publishes .git/HEAD events` (macOS fs-events), unrelated to this milestone.
2. Workflow run state is process-local (like `BackgroundJob` and the OAuth registry): a daemon restart loses observation of an in-flight run. The persisted run script and the durable `started`/`finished` events are the recovery artifacts; durable cross-restart run state is a future milestone.
3. `/effort ultrathink` intent is session-local, not a durable session-schema flag (item 11 note).
4. Arbitrary saved `.mjs` workflows register but are not yet client-exposed pending the dormant command-plugin boot path (item 12 note). `/deep-research` ships as a built-in TUI command and is unaffected.
5. The worker sandbox is defense-in-depth, not a hard security boundary. The script's only capability is coordination; spawned agents act under the unchanged permission and read-only-tool regime.
6. OpenAI reasoning-effort variants are not curated this milestone (the variant mechanism is provider-neutral; only the Anthropic definitions ship).
