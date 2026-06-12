# Ultrathink Workflows — Adversarial Review Notes (working doc)

## Verified so far (ran, not trusted)
- A `bun test test/workflow/`: 45 pass / 0 fail (4 files)
- B `bun test test/workflow/`: 59 pass / 0 fail (8 files) — **B claimed 73 workflow tests; actual 59** (inflated; +22 expects in test/tool/registry.test.ts don't make up the gap)
- A typecheck packages/opencode: clean
- B typecheck packages/opencode: clean

## Sandbox verdict
- **A (Bun Worker)**: separate JS realm/thread; strips Bun/process/require/fetch/WebSocket/XHR/EventSource/Worker/navigator via delete + non-writable defineProperty + param shadowing; script validation layer on top. Matches spec req #1 ("isolated Bun Worker"). Residual: dynamic `import()` inside Function-constructed code is a known V8-level vector — validation must reject `import` tokens; verify script.ts.
- **B (node:vm)**: vm context with host functions injected. **Trivially escapable**: `log.constructor("return process")()` reaches host process — classic vm escape. B's own comments admit "vm is not a hard security boundary". Also violates spec req #1 (no Worker).

## Architecture verdict (provisional): BASE = A
- A: Bun Worker sandbox (spec), WorkflowRun host w/ generation-guarded pause/resume via worker teardown + (phase,prompt) content-addressed cache replay, per-agent stop/restart, caps (16 conc / 1000 total), server HTTP control routes (/experimental/workflow), TUI dialog with ALL spec keybinds (↑↓/enter/esc/p/x/r/s) wired to those routes end-to-end, /effort dialog with ultrathink, /workflow command + saved-workflow commands gated by kill switch, keyword detection in prompt.ts, bestVariant (xhigh→max→high) resolution.
- B's unique value to graft: /effort ultrathink integration into the EXISTING variant cycling system (variant.shared.ts, keybind.ts, dialog-variant, local.tsx, run CLI runtime), demo.test.ts (spec-required), extra test coverage to port, possibly richer schema.

## Bugs found in A so far
- EffortDialog (tui feature-plugins/workflows/index.tsx): ultrathink option NOT hidden when workflows disabled — kill switch must hide the effort option (spec req #13). FIX REQUIRED.

## TODO
- Read A: runtime.ts, script.ts, schema.ts, registry.ts, tool/workflow.ts, server routes/handlers
- Read B: TUI plugin, ultrathink.ts, variant.shared diff, prompt.ts diff, schema.ts
- Attack: script validation vs dynamic import; concurrency cap actually enforced; cache correctness on resume; model-agnosticism grep
- Assemble: copy A tree → final; graft B variant cycling + tests; fix kill-switch effort gap
