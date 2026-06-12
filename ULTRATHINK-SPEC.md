# ULTRATHINK WORKFLOWS — Implementation Spec (gte-agent)

You are implementing **dynamic workflows** natively in the gte-agent codebase (a fork of anomalyco/opencode — Bun + TypeScript + Effect v4 monorepo). This is a real, mergeable implementation, not a prototype. The product reference is Claude Code's "dynamic workflows" feature, renamed **ultrathink** for our product.

Read `docs/workflows-prd.md` in the repo first — it is the full PRD. Where the PRD says `ultracode`, our name is **`ultrathink`**. This spec overrides the PRD on naming and on anything listed here.

## Product requirements (hard)

1. **Workflow runtime**: a JavaScript orchestration script executed in an isolated Bun Worker (no fs/shell/network from the script itself). Injected API globals:
   - `phase(name, fn)` — declare a named phase; groups agents in the UI
   - `agent({ prompt, type?, model?, variant? })` — spawn one subagent, resolves `{ text, tokens }`
   - `map(items, fn, { concurrency? })` — bounded parallel fan-out
   - `log(message)` — progress line visible in the UI
   - `args` — structured invocation input (undefined if none)
   - Script's resolved return value = the workflow result delivered to the parent session.
2. **Agent execution**: workflow agents are real subagent sessions spawned through the existing task/session machinery (`src/tool/task.ts` → `TaskPromptOps`, `Session`, `subagent-permissions`). Respect existing permission derivation. Caps: **16 concurrent** (fewer on low-core machines: `min(16, max(2, cores - 2))`), **1,000 agents total per run**.
3. **Model-agnostic**: works with ANY primary model — Fable 5, Opus 4.6/4.8, GPT-5.5, etc. Per-agent `model`/`variant` overrides route through the existing provider/variant system. Nothing may be hardcoded to Anthropic.
4. **`workflow` tool**: a new tool (registered in `src/tool/registry.ts`) the model calls to launch a run: params `{ name, script, args?, background? }`. Validates the script, starts the run via the runtime, returns the run id + script file path. Runs execute in the background (existing `BackgroundJob` patterns); completion notifies the session like background tasks do.
5. **Script persistence**: every run writes its script to the project data dir (follow how plans/sessions store files; e.g. alongside session storage). Path is returned to the model and shown in the UI.
6. **`/effort ultrathink`**: extend the effort/variant selection (`cli/cmd/run/variant.shared.ts`, TUI variant cycling, `/effort` command if present — investigate how effort/variant selection is surfaced in the TUI) with an `ultrathink` option = highest available reasoning variant for the current model (`xhigh` if available, else `max`, else `high`) **plus** a session flag that instructs the model (via system prompt addition) to plan a workflow for substantive tasks.
7. **`ultrathink` keyword + `/workflow` command**: a slash command `/workflow <task>` that injects an instruction to run the task as a workflow. The word `ultrathink` in a user prompt should likewise opt that task into workflow planning (system-prompt instruction is acceptable for v1; input highlighting is a nice-to-have, skip if it risks the schedule).
8. **TUI `/workflows` view** — THE CENTERPIECE. A TUI feature (study `packages/opencode/src/cli/cmd/tui/feature-plugins/` and `routes/` to find the right pattern — there is an existing task/background panel to model on):
   - `/workflows` lists running + completed runs for the session
   - Selecting a run opens a progress view: each **phase** with agent count, token total, elapsed time; live updates from runtime events
   - Drill into a phase → list of agents with status; drill into an agent → its prompt, recent tool activity, result
   - Keybinds: `↑/↓` select, `Enter/→` drill in, `Esc` back, `p` pause/resume, `x` stop agent/run, `r` restart agent, `s` save run script to `.opencode/workflows/<name>.mjs`
   - A compact one-line progress indicator while a run is active (reuse however background tasks surface today)
9. **Saved workflows**: `.opencode/workflows/*.mjs` (project) and `~/.config/opencode/workflows/*.mjs` (global) register as slash commands `/<name>` (study `src/command/` — custom commands already exist; follow that registration path). Frontmatter comment block `// --- name/description ---`. `args` passed as structured data. Project wins name collisions.
10. **Bundled `/deep-research`**: ship a deep-research workflow script as a built-in (fan out angles → cross-check claims → cited synthesis, claims failing cross-check filtered).
11. **Pause/resume**: runtime caches each agent's result keyed by (phase, prompt hash). Pausing stops new spawns; resuming re-executes the script with cached results returned instantly for completed agents. Same-session only.
12. **Events**: runtime emits typed events (run started/phase started/agent started/agent finished/log/run finished/error) through the existing event bus (`EventV2Bridge` or whatever the codebase uses) so the TUI and server API can subscribe.
13. **Config kill switch**: `disableWorkflows` config key + env `GTE_AGENT_DISABLE_WORKFLOWS=1` — hides the tool, the commands, and the effort option.

## Engineering requirements (hard)

- New code lives in `packages/opencode/src/workflow/` (runtime, registry, schema, worker host) + minimal touch points elsewhere (tool registry, command registry, TUI plugin, variant/effort, config schema).
- Follow the codebase's Effect v4 idioms (read `.opencode/skills/effect/SKILL.md` and neighboring services for patterns — `Context.Service`, `Layer`, `Schema` from `effect`). Match existing code style; no new dependencies unless absolutely necessary.
- **Tests**: bun tests for the runtime (phase/agent/map semantics, caps, cancellation, result caching, script sandbox — no fs/shell access), the workflow tool params, and saved-workflow discovery/registration. Put them under `packages/opencode/test/workflow/`.
- **Nothing existing may break**: `cd packages/opencode && bun test` must not regress (some pre-existing failures may exist — record baseline first, compare after).
- Typecheck must pass: run `bun run typecheck` if the script exists, else `bunx tsc --noEmit` with the package tsconfig.
- Commit your work to your branch with clear conventional-commit messages. Do NOT push. Do NOT open PRs. Do NOT touch `main`.

## Verification before you report done

1. Baseline then final: `bun test` (record pass/fail counts), typecheck clean.
2. A demo: `packages/opencode/test/workflow/demo.test.ts` (or a script) that runs a tiny 2-phase workflow end-to-end with a stubbed agent executor proving phases, parallelism cap, caching, and result delivery work.
3. TUI compiles. If you can smoke-run the TUI non-interactively to confirm the route/command registers without crashing, do it; otherwise verify via tests/typecheck and say exactly what is verified vs not.

## Report format (your final message)

- What you built, file-by-file map (new + modified)
- What works (verified) vs what is stubbed/unverified — be brutally honest, the adversarial reviewer will check
- Test results: baseline vs final counts, typecheck status
- Known gaps, risks, TODOs
- Branch name + final commit hash
