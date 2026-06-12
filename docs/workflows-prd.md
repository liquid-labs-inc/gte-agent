# PRD: Dynamic Workflows for gte-agent

| | |
|---|---|
| **Status** | Draft v1 |
| **Owner** | Enzo (liquid-labs-inc) |
| **Parity target** | Claude Code dynamic workflows (v2.1.154+, GA June 2026) |
| **Tracking** | This document |

## 1. Summary

A **dynamic workflow** is a JavaScript script that orchestrates subagents at scale. The agent writes the script for the task the user describes, and a runtime executes it in the background while the session stays responsive. This PRD specifies feature-exact parity with Claude Code's dynamic workflows, mapped onto the opencode architecture that gte-agent is built on.

The defining property: **the plan moves into code.** With subagents and skills, the model is the orchestrator — it decides turn by turn what to spawn, and every intermediate result lands in its context window. A workflow script holds the loop, the branching, and the intermediate results itself, so the model's context holds only the final answer, and the orchestration becomes an artifact you can read, diff, edit, and rerun.

## 2. Why (vs. what we already have)

gte-agent already ships the `task` tool (parallel + background subagents), skills, and per-agent model/variant config. What it cannot do:

| Capability | task tool today | Workflows |
|---|---|---|
| Who decides what runs next | Model, turn by turn | The script |
| Intermediate results | Land in model context | Stay in script variables |
| Scale per run | A few tasks per turn | Dozens to hundreds of agents |
| Repeatability | Re-prompt and hope | Saved script, identical orchestration |
| Interruption | Restarts the turn | Resumable in the same session |
| Quality patterns | Ad hoc | Codified (adversarial review, multi-angle drafting, claim voting) |

Target use cases (same as Claude Code's): codebase-wide audits, 500-file migrations, cross-checked research, hard plans drafted from several independent angles.

## 3. User experience (parity-exact)

### 3.1 Three ways to start a workflow

1. **Keyword in prompt.** Including the keyword `ultracode` in a prompt runs that single task as a workflow without changing session effort. Natural-language requests ("use a workflow", "run a workflow") trigger the same opt-in. The TUI highlights the keyword in the input; `Option+W` (macOS) / `Alt+W` (Win/Linux) dismisses the highlight for that prompt; backspace after the highlight removes it. A config toggle ("Ultracode keyword trigger") disables keyword detection entirely.
2. **Session effort mode.** `/effort ultracode` combines `xhigh` reasoning effort with automatic workflow orchestration: the model plans a workflow for every substantive task instead of waiting to be asked. Session-scoped; resets on new session. Only offered on models that support `xhigh` effort (Opus 4.8, Fable 5; on others the `/effort` menu omits it). A single request may produce several workflows in sequence (understand → change → verify).
3. **Run a saved/bundled command.** `/deep-research <question>` (bundled) or any saved workflow runs as `/<name>` and appears in `/` autocomplete.

### 3.2 Approval before run

CLI prompt shows the planned phases plus options:

- **Yes, run it**
- **Yes, and don't ask again for `<name>` in `<path>`** (per-workflow, per-project consent)
- **View raw script** (read before deciding; `Ctrl+G` opens the script in `$EDITOR`; `Tab` adjusts the prompt before starting)
- **No**

Prompting by permission mode:

| Permission mode | When prompted |
|---|---|
| Default, accept-edits | Every run unless "don't ask again" recorded for that workflow+project |
| Auto | First launch only; any Yes records consent in user settings. Skipped entirely under ultracode |
| Bypass permissions / non-interactive / SDK | Never; run starts immediately |

The launch prompt is the only thing permission mode controls. **Workflow subagents always run in accept-edits mode and inherit the user's tool allowlist** regardless of session mode. File edits are auto-approved. Shell/webfetch/MCP calls outside the allowlist still prompt mid-run.

### 3.3 Watching runs: `/workflows`

Background execution; session stays responsive. `/workflows` lists running and completed runs; selecting one opens a progress view showing each **phase** with agent count, token total, elapsed time. A one-line progress summary also renders in the task panel under the input box.

Keybinds (exact):

| Key | Action |
|---|---|
| `↑`/`↓` | Select phase or agent |
| `Enter`/`→` | Drill into phase → agent (prompt, recent tool calls, result) |
| `Esc` | Back out one level |
| `j`/`k` | Scroll agent detail |
| `p` | Pause / resume run |
| `x` | Stop selected agent, or whole run at run focus |
| `r` | Restart selected running agent |
| `s` | Save run's script as a command |

### 3.4 Saving and reusing

`s` in `/workflows` opens a save dialog; `Tab` toggles destination:

- **`.opencode/workflows/`** in the project — shared via the repo. (Also discover **`.claude/workflows/`** for drop-in Claude Code compatibility, mirroring our existing `.claude/skills/` support.)
- **`~/.config/opencode/workflows/`** — personal, all projects.

Saved workflows run as `/<name>`; project beats personal on name collision.

### 3.5 Passing input

A saved workflow accepts invocation input via an `args` parameter, exposed to the script as a global named `args`, passed as structured data (arrays/objects usable without parsing). Omitted → `undefined`.

### 3.6 Bundled workflow

`/deep-research <question>`: fans out web searches across several angles, fetches and cross-checks sources, votes on each claim, returns a cited report with claims that failed cross-checking filtered out. Requires the `websearch` tool.

## 4. Runtime design

### 4.1 Execution environment

- Script is **JavaScript**, executed in an isolated environment (Bun `Worker` with no `fs`/`child_process`/`Bun.spawn` — only the workflow API surface is injected). The script coordinates; **agents** do all reading, writing, and command-running.
- Every run writes its script to a file under the session directory (`~/.local/share/opencode/project/<id>/workflows/<runID>.mjs`). The model receives the path at launch so the user can ask for it, diff it against a previous run, or edit and relaunch.
- Runtime records each agent's result as the run progresses (content-addressed by phase + prompt), which is what makes runs resumable.

### 4.2 Script API (injected globals)

Anthropic does not publish Claude Code's internal script API, so we define an equivalent surface and hold it stable:

```ts
declare global {
  /** Structured invocation input for saved workflows; undefined if not provided. */
  const args: unknown

  /** Declare a named phase. Progress UI groups agents by phase. */
  function phase<T>(name: string, fn: () => Promise<T>): Promise<T>

  /** Spawn one subagent. Resolves with its final message. */
  function agent(opts: {
    prompt: string
    /** Agent type from the registry; defaults to "general". */
    type?: string
    /** Model override for this agent, e.g. "anthropic/claude-sonnet-4-6". */
    model?: string
    /** Reasoning-effort variant for this agent, e.g. "low" | "high" | "xhigh". */
    variant?: string
  }): Promise<{ text: string; tokens: { input: number; output: number } }>

  /** Spawn many subagents with bounded concurrency (runtime caps still apply). */
  function map<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, opts?: { concurrency?: number }): Promise<R[]>

  /** Append a line to the run's progress log (visible in /workflows). */
  function log(message: string): void

  /** Final result delivered back to the session when the script returns. */
}
```

The script's resolved return value (string or JSON-serializable) is delivered to the parent session as the workflow result — the only thing that enters the model's context.

### 4.3 Behavior and limits (parity-exact)

| Constraint | Value | Why |
|---|---|---|
| Mid-run user input | None — only agent permission prompts pause a run | Stage sign-off = run stages as separate workflows |
| Script filesystem/shell access | None | Agents do the work; script coordinates |
| Concurrent agents | 16 max, fewer on low-core machines (`min(16, cores - 2)`) | Bounds local resource use |
| Total agents per run | 1,000 | Backstop against runaway loops |
| Pause/resume | Within same session; completed agents return cached results | Resumability |
| Exit during run | Next session starts the workflow fresh | No cross-session persistence in v1 |

### 4.4 Model routing & cost

- Every agent uses the session model unless the script routes a stage elsewhere (`model`/`variant` per agent).
- `/workflows` shows per-agent and per-phase token usage live; stopping a run keeps completed work.
- Runs count toward normal usage/rate limits. Docs guidance: trial a small slice first; route cheap stages to a smaller model.

### 4.5 Workflow file format

Saved workflow = one `.mjs` file with a frontmatter comment block:

```js
// ---
// name: triage-issues
// description: Triage a list of GitHub issues with cross-review
// ---
const issues = args ?? []
const findings = await phase("investigate", () =>
  map(issues, (n) => agent({ prompt: `Investigate issue #${n}...`, type: "explore" })))
const reviewed = await phase("adversarial-review", () =>
  map(findings, (f, i) => agent({ prompt: `Find flaws in this finding:\n${f.text}`, variant: "high" })))
return reviewed.map((r) => r.text).join("\n\n")
```

### 4.6 Disable switches (parity-exact)

- `/config` row "Dynamic workflows" (persisted)
- `"disableWorkflows": true` in user config
- `GTE_AGENT_DISABLE_WORKFLOWS=1` (env)
- Org-managed config

Disabled ⇒ bundled commands disappear, keyword stops triggering, `ultracode` removed from `/effort` menu.

## 5. Architecture mapping (opencode internals)

| Component | Builds on |
|---|---|
| Workflow runtime | New `packages/opencode/src/workflow/` — run registry, Bun worker host, agent-result cache |
| Agent spawning | Existing `Session`/`task` machinery (`src/tool/task.ts` → factored `TaskPromptOps`); workflow agents are subagent sessions with `acceptEdits` permission derivation |
| Background runs + notify | Existing `BackgroundJob` (`src/background/job.ts`) |
| `/workflows` view | New TUI feature-plugin (`cli/cmd/tui/feature-plugins/workflows/`), modeled on the session task panel |
| Saved-workflow commands | Existing command registry (`src/command/`) — workflows register as slash commands like skills/commands do |
| Keyword highlight | TUI input pipeline; config flag in keybind/config schema |
| `/effort ultracode` | Variant system (`run/variant.shared.ts`) — `ultracode` = `xhigh` variant + `workflow_auto` session flag |
| Permissions | Existing `Permission` + new `workflow` permission kind (mirrors `websearch`/`skill` ask pattern) |
| Consent persistence | Project-scoped storage alongside existing permission "always" records |

## 6. Milestones

| | Scope | Exit criteria |
|---|---|---|
| **M0** | **Workflows skill** (ships with this PRD — see `.opencode/skills/workflows/`): skill-driven orchestration emulating the workflow pattern with the existing task tool; workflow definitions in `.opencode/workflows/` | Agent can read a workflow definition and execute phased, parallel, cross-reviewed runs today |
| **M1** | Runtime + script API + `workflow_run`/`workflow_status` tools; approval flow; limits | `/deep-research` script runs end-to-end headless |
| **M2** | `/workflows` TUI view, pause/resume/restart/save, task-panel progress line | Keybind table above fully functional |
| **M3** | `ultracode` keyword detection + highlight + dismiss; saved-workflow slash commands; `args` passing | Saved workflow runs as `/<name>` with structured args |
| **M4** | `/effort ultracode` auto-orchestration; disable switches; org config | Parity checklist (Appendix A) fully green |

## 7. Non-goals (v1)

- Cross-session resume after exiting the app (Claude Code doesn't either)
- Mid-run interactive input to the script
- Distributed/remote execution of workflow agents (single-machine, like Claude Code)
- A visual workflow editor

## 8. Risks

| Risk | Mitigation |
|---|---|
| Token blowups (one user burned ~70% of a 5h window in 30 min on ultracode) | Live token display per phase/agent; small-slice guidance; agent caps; stop-without-losing-work |
| Script sandbox escapes | No ambient capabilities in worker; API surface is the only I/O; script cannot touch fs/shell |
| Mid-run permission stalls on long runs | Pre-run hint listing tools agents will need outside the allowlist |
| Upstream merge conflicts (fork tracks opencode) | Keep runtime in new `src/workflow/` dir; minimal touch points (task ops, command registry, TUI plugin) |

## Appendix A: Parity checklist vs Claude Code

- [ ] JS script orchestration, runtime-executed, background, session stays responsive
- [ ] Script written by the model for the described task
- [ ] `ultracode` keyword trigger + highlight + Option/Alt+W dismiss + config toggle
- [ ] Natural-language opt-in ("use a workflow")
- [ ] `/effort ultracode` (= `xhigh` + auto-orchestration), session-scoped, model-gated
- [ ] Approval prompt: Yes / Yes-always-for-name-in-path / View raw script / No; `Ctrl+G` editor; `Tab` prompt edit
- [ ] Permission-mode-dependent prompting (default/auto/bypass)
- [ ] Subagents in accept-edits + inherited allowlist always
- [ ] `/workflows` list + progress view with exact keybind set
- [ ] Task-panel one-line progress summary
- [ ] Save to project + personal dirs; project wins collisions; `/` autocomplete
- [ ] `args` global, structured input
- [ ] Script file persisted per run, path surfaced
- [ ] Pause/resume with cached agent results, same session
- [ ] 16 concurrent / 1,000 total agent caps
- [ ] No script fs/shell; no mid-run user input
- [ ] Per-stage model routing
- [ ] Bundled `/deep-research` with claim cross-checking and voting
- [ ] Disable: config row, settings key, env var, managed settings; full feature retraction
