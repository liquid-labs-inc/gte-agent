# Milestone 8 — Ultrathink Dynamic Workflows

## Goal

Give the GTE agent a way to fan research out across many bounded subagent sessions at once — the model writes a small orchestration script, an isolated runtime executes it in the background, and the session, TUI, and audit trail all observe the run through the existing event machinery. Alongside it, finish reasoning-effort support for the curated Anthropic models (adaptive thinking for Claude Fable 5 and Opus 4.8) so the highest-effort tier exists for `ultrathink` to select.

## End State

After Milestone 8:

- `packages/llm` understands Anthropic adaptive thinking: `providerOptions.anthropic.thinking` accepts `{ type: "adaptive" }` in addition to the legacy `{ type: "enabled", budgetTokens }`, and models that omit thinking by default (Claude Fable 5, Opus 4.8) get `display: "summarized"` forced on the wire.
- The curated catalog defines reasoning-effort variants per Anthropic model: `low`/`medium`/`high`/`xhigh`/`max` for adaptive-efforts models that omit thinking by default (Fable 5, Opus 4.8), `low`/`medium`/`high`/`max` adaptive without a display override for Sonnet 4.6, and `high`/`max` budgeted legacy thinking for Haiku 4.5 — matching upstream opencode's per-generation treatment. `Session.model.variant` flows from model selection through `SessionRunner` into the LLM request; an unset variant means no thinking payload, exactly as today.
- A `workflow` tool exists: the model submits `{ name, script, args?, background? }`; the script runs in a sandboxed Bun Worker with only `phase`/`agent`/`map`/`log`/`args` injected; every agent the script spawns is a real child session created through `Session.create`/`Session.prompt` with the parent session's runtime scope and authority, observed to completion through durable session events.
- Workflow runs are visible three ways: durable `session.workflow.started`/`session.workflow.finished` events in the transcript (auditable, replayable), ephemeral `session.workflow.updated` snapshots over the existing SSE stream (live TUI), and `GET /api/session/:sessionID/workflow[/:runID]` snapshot routes.
- `gta` gains `/workflows` — an overlay (models-overlay pattern) listing the session's runs, with a two-panel run view (phases left, selected phase's agents right, status glyphs, token/elapsed stats) and an agent detail step. `p` pauses/resumes, `x` stops, `Esc` backs out.
- `gta` gains `/effort <low|medium|high|xhigh|max|ultrathink>`: the named tiers re-select the active model with that variant; `ultrathink` selects the highest variant the active model offers and turns on a session-intent flag that adds a workflow-orchestration instruction to system context.
- The literal word `ultrathink` in a user prompt opts that prompt into the same orchestration instruction; `/workflow <task>` does the same explicitly.
- Saved workflows: `.gte-agent/workflows/*.mjs` in the project and `~/.gte-agent/workflows/*.mjs` globally register as slash commands (project wins collisions). One bundled workflow ships: `/deep-research`, a multi-angle research fan-out with a cross-check phase that drops claims failing verification.
- `GTE_AGENT_DISABLE_WORKFLOWS=1` (flag) or `workflows: { enabled: false }` (config) hides the tool, the commands, the routes, and the effort option.
- Run scripts persist to disk under the agent data dir; the run registry itself is process-local (same acceptance as the OAuth registry: restart loses live runs — recorded as a known limitation, not silently).
- All existing suites stay green from package dirs; new behavior is covered by tests in the owning packages.

## Scope

### 1. Anthropic adaptive thinking + effort variants (`packages/llm`, `packages/core`)

Phase 1 shipped model selection with a `variant` slot already plumbed through `models.select` and persisted on the session, but no variant definitions and no thinking lowering beyond legacy `enabled`. This milestone fills that in for the curated Anthropic models only:

- `anthropic-messages.ts`: extend `lowerThinking` to accept `{ type: "adaptive" }`, and force `display: "summarized"` for models whose generation defaults thinking display to omitted (Fable 5, Opus 4.7+). Detection is by model id substring, mirroring the upstream opencode fix (anomalyco/opencode `c4bc9029`); provenance matters because Fable launched after our pinned revision.
- `catalog-curated.ts`: attach variants to the four Anthropic models. Variant `body` carries the exact `providerOptions.anthropic.thinking` payload; the runner applies it without interpreting effort names.
- `session/runner/llm.ts`: resolve the session's variant against the model's catalog variants and merge the variant body into the request. Unknown variant on the selected model is a visible error directing at `/models`, never a silent drop.
- OpenAI variants are out of scope this milestone; the variant *mechanism* is provider-neutral, only the curated definitions are Anthropic-first.

### 2. Workflow runtime (`packages/core/src/workflow/`)

The orchestration script is coordination-only: it cannot touch the filesystem, network, or shell. Only the agents it spawns can act, and those act through the same session machinery as any other session — same tool registry, same read-only GTE data boundary, same permission derivation, same durable settlement.

- Script validation rejects `import`, `eval`, `Function`, `.constructor`, `globalThis` before execution; the Bun Worker host strips `Bun`, `process`, `require`, `fetch`, and network/Worker globals from the script's scope. This is defense-in-depth, not a hard security boundary — recorded as such.
- Injected API: `phase(name, fn)` groups agents for observation (no nesting); `agent({ prompt, type?, model?, variant? })` resolves `{ text, tokens }`; `map(items, fn, { concurrency? })` is bounded fan-out; `log(message)` emits a progress line; `args` is the structured invocation input. The script's resolved return value is the run result.
- Agent execution: child session per `agent()` call — created with the parent's runtime scope and authority, prompted once, observed via session events until the turn settles, final assistant text and token usage extracted. A requested model/variant unavailable in this environment falls back to the parent session's model (visible in the run snapshot, not silent).
- Caps: `min(16, max(2, cores - 2))` concurrent agents, 1,000 agents per run.
- Pause/resume: agent results cache by `(phase, hash(prompt + model + variant))`. Pause stops new spawns; resume re-executes the script, cached agents resolve instantly. Process-local, same-session only.
- Run scripts persist to `<data dir>/workflow-runs/<runID>.mjs` following the same data-dir convention as the SQLite store; the path is returned to the model and shown in the TUI.

### 3. Workflow tool + events + routes (`packages/core`, `packages/server`)

- `workflow` tool registered alongside the builtins, gated on the kill switch. Default (`background` absent or false): the tool settles when the run finishes and returns `{ runID, scriptPath, status, result, tokens }` — durable tool settlement gives the audit trail for free. `background: true` starts the run under `BackgroundJob` and returns `{ runID, scriptPath }` immediately; completion surfaces the way background jobs already do.
- Durable events `session.workflow.started` / `session.workflow.finished` (run id, name, script path, terminal status, token total, duration). High-frequency progress is ephemeral: `session.workflow.updated` carries a full run snapshot and merges into the existing SSE stream exactly like `session.panel.updated` — snapshot, not delta, so the TUI reducer stays trivial.
- `WorkflowGroup` on the HTTP API: `GET /api/session/:sessionID/workflow` (list snapshots), `GET /api/session/:sessionID/workflow/:runID` (one snapshot), `POST /api/session/:sessionID/workflow/:runID/control` with `{ action: "pause" | "resume" | "stop", agentID? }`.
- Run snapshot shape (shared schema, `packages/core/src/workflow/schema.ts`): run id, name, status (`running`/`paused`/`completed`/`failed`/`stopped`), script path, token total, started/finished times, ordered phases (name, status, agent count, tokens), agents (id, phase, prompt head, model, variant, status, tokens, error), recent log lines.

### 4. `gta` surfaces (`packages/tui`)

- `/workflows` overlay follows the models-overlay step machine: run list → run view → agent detail. Run view is two-panel — phases left, selected phase's agents right, status glyphs from the existing status-color conventions, token and elapsed stats right-aligned, completed/total in the header. Narrow terminals stack the panels. State lives in `state/workflows.ts` as pure reducers over run snapshots; SSE `session.workflow.updated` feeds it.
- A compact one-line indicator surfaces an active run above the prompt (same slot conventions as existing transient status lines).
- `/effort` slash command as described in End State. `ultrathink` resolution order: `xhigh` if the active model offers it, else `max`, else `high`; models with no variants get the intent flag only, with an info line saying so.
- `/workflow <task>` injects the orchestration instruction with the task text. Keyword detection for `ultrathink` happens server-side in system-context assembly (CONTEXT.md epoch rules), not in the TUI.
- Status bar shows the active variant: `model anthropic/claude-fable-5 (xhigh)`.

### 5. Saved workflows + bundled `/deep-research` (`packages/core`)

- Discovery at command-registry build: project `.gte-agent/workflows/*.mjs`, then global `~/.gte-agent/workflows/*.mjs`, project wins name collisions. Frontmatter comment block (`// --- name: ... / description: ... ---`) supplies metadata; the command template invokes the `workflow` tool with the file's script and the user's arguments as `args`.
- `/deep-research` ships as a bundled script: fan out independent research angles, cross-check claims against sources in a second phase, synthesize only claims that survive. Framed for market/asset research — the agents' tool surface is the read-only GTE data set plus whatever the session already has.

### 6. Kill switch + config (`packages/core`)

- `GTE_AGENT_DISABLE_WORKFLOWS` truthy flag, plus `workflows: { enabled?: boolean }` (default true) on `Config.Info`. Either off: the tool is not contributed, saved-workflow commands are not registered, `/workflows` and `/effort ultrathink` report the feature disabled, workflow routes answer with a typed disabled error.

## Out Of Scope

- Durable cross-restart run persistence and resume. The run registry is process-local like `BackgroundJob` and the OAuth registry; scripts on disk are the recovery artifact. A future milestone can add a drizzle-backed run table without changing the event contract.
- Mutation tools for workflow agents. The read-only boundary and `audit:gte` gate are untouched; workflow agents see exactly the tool surface any session sees.
- Clustering / remote workflow execution; `SessionRunCoordinator` stays process-local per Phase 1.
- OpenAI reasoning-effort variant definitions (mechanism is neutral; curation deferred).
- Prompt-input highlighting of the `ultrathink` keyword.
- CLI (`gte-agent`) workflow subcommands; the TUI and HTTP API are the Phase observation surfaces.
- Workflow-specific memory or cross-run learning.

## Implementation Checklist

1. `lowerThinking` accepts `{ type: "adaptive" }` and forces `display: "summarized"` for Fable 5 / Opus 4.7+; legacy `enabled` path byte-identical for existing models. Tests: prepared-body assertions for fable adaptive+summarized, opus-4-8 adaptive+summarized, sonnet legacy budget unchanged, invalid thinking rejected.
2. Curated catalog variants for the four Anthropic models with exact thinking payloads; catalog tests assert variant ids and bodies per model.
3. Runner merges the selected variant body into the LLM request; unknown variant is a visible session error. Tests: variant flows to prepared request; no variant means no thinking key; unknown variant errors.
4. `workflow/schema.ts` run/phase/agent snapshot schemas + `workflow/script.ts` validation (rejection cases tested: `import`, `eval`, `Function`, `.constructor`, `globalThis`).
5. Worker host executes a script with injected `phase`/`agent`/`map`/`log`/`args` and stripped globals; sandbox tests prove `Bun`/`process`/`require`/`fetch` are absent in script scope.
6. Runtime: phase grouping, `map` concurrency bound, 16/1000 caps enforced, pause/resume result caching by `(phase, prompt hash)`, run result delivery, error propagation with useful messages. Tests run against a stubbed agent executor.
7. Agent executor: child session with parent scope + authority, prompt, observe to settlement, extract text + tokens; unavailable model override falls back to the parent model. Test with the demo runner (`GTE_AGENT_LLM=demo`).
8. `workflow` tool: param validation, synchronous settlement returning the result, `background: true` via `BackgroundJob`, script persisted and path returned. Registry test proves the tool is contributed exactly when the kill switch allows.
9. Durable started/finished events + ephemeral snapshot event published through the existing buses; server `WorkflowGroup` list/get/control routes with httpapi-exercise coverage.
10. `/workflows` overlay: list → run view (two-panel, stacked fallback) → agent detail; pause/stop keybinds; reducer tests over snapshot sequences plus a `testRender` flow against the mock fixture.
11. `/effort` command incl. `ultrathink` resolution and session-intent flag; status bar variant display; system-context orchestration instruction for the intent flag, the keyword, and `/workflow`. TUI + core tests.
12. Saved-workflow discovery, project-over-global collision, frontmatter parsing, command registration; bundled `/deep-research` registers and validates. Tests cover discovery and collision.
13. Kill switch: flag and config both gate tool, commands, routes, effort option — each gate tested.
14. End-to-end demo: with `GTE_AGENT_LLM=demo`, a two-phase workflow with fanned-out agents completes through the real tool → runtime → child-session path; transcript shows started/finished durable events; `/workflows` renders the finished run. Recorded as the milestone's live check.
15. Cross-package sweep recorded in the acceptance record: per-package `bun test` counts vs the M7 baseline (core 1052/1 pre-existing watcher fail/1 skip, llm 297/28 skip, server 99, tui 125), `bun turbo typecheck`, `bun run lint`, `bun run audit:gte`.

## Risks

- **Child-session fan-out hits paths Phase 1 never exercised concurrently.** Sixteen simultaneous session creations and prompt admissions through `SessionRunCoordinator` is new load. Mitigation: caps are enforced runtime-side, the demo-runner e2e test exercises real concurrency, and the executor serializes creation if instability appears (cap reduction is a config-free constant).
- **Worker sandbox overclaim.** Validation plus global-stripping is not a security boundary and a determined script may find a gap. Mitigation: the script's only capabilities are coordination; agents act under the unchanged permission/tool regime. The acceptance record states the defense-in-depth posture explicitly.
- **Token cost surprise.** A 1,000-agent run is expensive by design. Mitigation: caps, live token totals in `/workflows`, pause/stop controls, and the orchestration instruction tells the model to scale fan-out to the task.
- **Variant payload drift.** Anthropic thinking payload shapes for new generations may change again. Mitigation: payloads live in catalog data, not protocol logic; one place to update, covered by prepared-body tests.
- **Ephemeral snapshot volume.** Full-run snapshots on every agent transition could be chatty for large runs. Mitigation: snapshots coalesce on a short tick (panel events set precedent); the schema carries totals so the TUI never needs every intermediate.
- **Process-local registry surprises users.** A TUI restart mid-run loses observation of a live run. Mitigation: documented limitation; durable started/finished events plus the persisted script mean nothing audit-relevant is lost.
