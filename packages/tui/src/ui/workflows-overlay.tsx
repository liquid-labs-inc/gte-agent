import type { KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { isWorkflowsDisabled, type WorkflowsApi } from "../api/workflows"
import {
  agentProgress,
  backStep,
  enterStep,
  initialStep,
  isActiveRun,
  isNarrow,
  moveStep,
  phaseAgents,
  stepAgent,
  stepRun,
  totalTokens,
  type AgentInfo,
  type AgentStatus,
  type PhaseInfo,
  type RunSnapshot,
  type RunStatus,
  type WorkflowStep,
  type WorkflowsState,
} from "../state/workflows"
import { theme } from "./theme"

const MAX_PROMPT_PREVIEW = 120

/**
 * The /workflows modal overlay (Milestone 8), mirroring the /models overlay
 * pattern: rendered in place of the prompt input (which unmounts, so its key
 * handlers go away), with a prepended keypress listener that makes the overlay
 * modal — it consumes every key except Ctrl+C.
 *
 * Three steps over the live run registry (`state/workflows.ts`):
 * - list:  one row per run (status glyph, agents-done/total, tokens, elapsed),
 *   newest first
 * - run:   two-panel — phases left, the selected phase's agents right; narrow
 *   terminals stack the panels; recent log lines at the bottom
 * - agent: prompt head, requested-vs-effective model/variant, status, tokens,
 *   error/result text
 *
 * Keybinds: ↑/↓ select, Enter/→ drill in, Esc back (closes from the list step),
 * p pause/resume the run, x stop (the run at the run step, the agent at the
 * agent step). The registry itself lives in the app store and feeds in through
 * props so SSE snapshots keep the view live while the overlay is open.
 */
export function WorkflowsOverlay(props: {
  workflows: WorkflowsApi
  sessionID: string
  state: WorkflowsState
  onClose: () => void
  /** Disabled kill-switch surfaced to the app for the error line. */
  onDisabled?: () => void
}) {
  // Clone the shared initial step: createStore proxies the object and would
  // otherwise mutate the exported `initialStep` constant in place.
  const [step, setStep] = createStore<{ value: WorkflowStep }>({ value: { ...initialStep } })
  const [error, setError] = createSignal<string | undefined>(undefined)
  // Bumped on every navigation so an in-flight control request cannot land on a
  // different step or after the overlay closes.
  let epoch = 0

  const renderer = useRenderer()
  const [columns, setColumns] = createSignal(renderer.terminalWidth)
  const onResize = () => setColumns(renderer.terminalWidth)

  const current = () => step.value
  const run = createMemo(() => stepRun(props.state, current()))
  const agent = createMemo(() => stepAgent(props.state, current()))
  const stacked = createMemo(() => isNarrow(columns()))

  const move = (delta: number) => setStep("value", (value) => moveStep(props.state, value, delta))
  const enter = () => setStep("value", (value) => enterStep(props.state, value))
  const back = () => {
    epoch++
    const next = backStep(props.state, current())
    if (next === undefined) return props.onClose()
    setStep("value", next)
    setError(undefined)
  }

  const describe = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))

  const control = (runID: string, action: "pause" | "resume" | "stop", agentID?: string) => {
    const captured = ++epoch
    setError(undefined)
    props.workflows.control(props.sessionID, runID, action, agentID).catch((caught: unknown) => {
      if (captured !== epoch) return
      if (isWorkflowsDisabled(caught)) {
        props.onDisabled?.()
        props.onClose()
        return
      }
      setError(describe(caught))
    })
  }

  // The run a pause/stop targets: the drilled-in run, else the highlighted list row.
  const targetRun = () => {
    const value = current()
    if (value.kind === "list") return props.state.runs[value.selected]
    return run()
  }

  const toggleRun = () => {
    const target = targetRun()
    if (target === undefined) return
    if (!isActiveRun(target)) {
      setError(`Run is ${target.status}; nothing to pause or resume.`)
      return
    }
    control(target.id, target.status === "paused" ? "resume" : "pause")
  }

  const stop = () => {
    const value = current()
    if (value.kind === "agent") {
      control(value.runID, "stop", value.agentID)
      return
    }
    const target = targetRun()
    if (target === undefined) return
    if (!isActiveRun(target)) {
      setError(`Run is ${target.status}; already stopped.`)
      return
    }
    control(target.id, "stop")
  }

  const listSelected = () => {
    const value = current()
    return value.kind === "list" ? value.selected : 0
  }
  const runPhase = () => {
    const value = current()
    return value.kind === "run" ? value.phase : 0
  }

  const onKey = (event: KeyEvent) => {
    if (event.ctrl && event.name === "c") return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "escape") return back()
    if (event.name === "up") return move(-1)
    if (event.name === "down") return move(1)
    if (event.name === "return" || event.name === "kpenter" || event.name === "linefeed" || event.name === "right") {
      return enter()
    }
    if (event.name === "p") return toggleRun()
    if (event.name === "x") return stop()
  }

  onMount(() => {
    renderer.keyInput.prependListener("keypress", onKey)
    renderer.on("resize", onResize)
  })
  onCleanup(() => {
    renderer.keyInput.off("keypress", onKey)
    renderer.off("resize", onResize)
  })

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={theme.accent}
      title="/workflows"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
      <Switch>
        <Match when={current().kind === "list"}>
          <RunList runs={props.state.runs} selected={listSelected()} />
        </Match>
        <Match when={current().kind === "run" && run()}>
          {(target) => <RunView run={target()} phase={runPhase()} stacked={stacked()} />}
        </Match>
        <Match when={current().kind === "agent" && run() !== undefined && agent()}>
          {(target) => <AgentDetail agent={target()} />}
        </Match>
        <Match when={true}>
          <text fg={theme.muted}>run no longer in the registry — esc to go back</text>
        </Match>
      </Switch>
    </box>
  )
}

function RunList(props: { runs: readonly RunSnapshot[]; selected: number }) {
  return (
    <box flexDirection="column">
      <Show when={props.runs.length === 0}>
        <text fg={theme.muted}>no workflow runs yet — the agent starts them with the workflow tool</text>
      </Show>
      <For each={props.runs}>
        {(run, index) => {
          const progress = agentProgress(run)
          return (
            <text fg={index() === props.selected ? theme.accent : theme.text}>
              {index() === props.selected ? "▸ " : "  "}
              {statusGlyph(run.status)} {run.name}
              {"  "}
              {progress.done}/{progress.total} agents · {totalTokens(run.tokens)} tok · {elapsed(run.time)}
            </text>
          )
        }}
      </For>
      <text fg={theme.muted}>↑↓ move · enter open · esc close</text>
    </box>
  )
}

function RunView(props: { run: RunSnapshot; phase: number; stacked: boolean }) {
  const progress = () => agentProgress(props.run)
  const selectedPhase = () => props.run.phases[props.phase]
  const agents = () => phaseAgents(props.run, selectedPhase()?.name)
  return (
    <box flexDirection="column">
      <text fg={theme.text}>
        {statusGlyph(props.run.status)} {props.run.name} · {props.run.status} · {progress().done}/{progress().total}{" "}
        agents · {totalTokens(props.run.tokens)} tok · {elapsed(props.run.time)}
      </text>
      <text fg={theme.muted}>{props.run.scriptPath}</text>
      <box flexDirection={props.stacked ? "column" : "row"}>
        <box flexDirection="column" flexGrow={1} paddingRight={props.stacked ? 0 : 2}>
          <text fg={theme.muted}>phases</text>
          <For each={props.run.phases}>
            {(phase, index) => <PhaseRow phase={phase} selected={index() === props.phase} />}
          </For>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <text fg={theme.muted}>agents · {selectedPhase()?.name ?? "—"}</text>
          <Show when={agents().length === 0}>
            <text fg={theme.muted}>no agents in this phase yet</text>
          </Show>
          <For each={agents()}>{(agent) => <AgentRow agent={agent} />}</For>
        </box>
      </box>
      <Show when={props.run.logs.length > 0}>
        <text fg={theme.muted}>recent log</text>
        <For each={props.run.logs.slice(-5)}>
          {(line) => (
            <text fg={theme.muted} wrapMode="word">
              {clock(line.time)} {line.message}
            </text>
          )}
        </For>
      </Show>
      <text fg={theme.muted}>↑↓ phase · enter agents · esc back · p pause/resume · x stop</text>
    </box>
  )
}

function PhaseRow(props: { phase: PhaseInfo; selected: boolean }) {
  const stats = () => {
    const base = `${props.phase.agents} agents · ${totalTokens(props.phase.tokens)} tok`
    return props.phase.time === undefined ? base : `${base} · ${elapsed(props.phase.time)}`
  }
  return (
    <text fg={props.selected ? theme.accent : theme.text}>
      {props.selected ? "▸ " : "  "}
      {phaseGlyph(props.phase.status)} {props.phase.name}
      {"  "}
      {stats()}
    </text>
  )
}

function AgentRow(props: { agent: AgentInfo }) {
  return (
    <text fg={agentColor(props.agent.status)} wrapMode="word">
      {statusGlyph(props.agent.status)} {props.agent.id} · {columnModelLabel(props.agent)} ·{" "}
      {totalTokens(props.agent.tokens)} tok · {elapsed(props.agent.time)}
    </text>
  )
}

function AgentDetail(props: { agent: AgentInfo }) {
  return (
    <box flexDirection="column">
      <text fg={theme.text}>
        {statusGlyph(props.agent.status)} {props.agent.id} · {props.agent.phase} · {props.agent.status}
      </text>
      <text fg={theme.muted} wrapMode="word">
        {props.agent.prompt.slice(0, MAX_PROMPT_PREVIEW)}
      </text>
      <text fg={theme.text}>model: {modelLabel(props.agent)}</text>
      <Show when={fallbackLabel(props.agent)}>{(label) => <text fg={theme.info}>requested: {label()}</text>}</Show>
      <text fg={theme.text}>
        tokens: {props.agent.tokens.input} in · {props.agent.tokens.output} out · {props.agent.tokens.reasoning}{" "}
        reasoning
      </text>
      <Show when={props.agent.error}>
        <text fg={theme.error} wrapMode="word">
          error: {props.agent.error}
        </text>
      </Show>
      {/* The snapshot carries no per-agent output text — only the run-level
          result, which belongs in the run view, not under one agent. The agent's
          own reply lives in its child session transcript (sessionID above). */}
      <text fg={theme.muted}>esc back · x stop agent</text>
    </box>
  )
}

/**
 * Effective "providerID/modelID (variant)" once settled, "—" before. This is
 * what the agent actually ran; any fallback from a requested model shows
 * separately via `fallbackLabel`.
 */
function modelLabel(agent: AgentInfo): string {
  const model = agent.model ?? "—"
  const variant = agent.variant === undefined ? "" : ` (${agent.variant})`
  return `${model}${variant}`
}

/**
 * The requested model/variant when it differs from the effective one — i.e. the
 * agent fell back to the parent session's model. Undefined when nothing was
 * requested or the request was honored. `requestedModel`/`requestedVariant` are
 * optional on the snapshot (a parallel workstream lands them), so this is a
 * no-op until they arrive.
 */
function fallbackLabel(agent: AgentInfo): string | undefined {
  if (agent.requestedModel === undefined && agent.requestedVariant === undefined) return undefined
  const requested = agent.requestedModel ?? agent.model ?? "—"
  const variant = agent.requestedVariant === undefined ? "" : ` (${agent.requestedVariant})`
  const label = `${requested}${variant}`
  return label === modelLabel(agent) ? undefined : label
}

/** Compact model column for the agent row: `requested→effective` on fallback, else effective. */
function columnModelLabel(agent: AgentInfo): string {
  const requested = fallbackLabel(agent)
  return requested === undefined ? modelLabel(agent) : `${requested}→${modelLabel(agent)}`
}

const statusGlyph = (status: RunStatus | AgentStatus): string => {
  if (status === "running") return "●"
  if (status === "paused") return "⏸"
  if (status === "completed") return "✓"
  if (status === "failed") return "✗"
  if (status === "stopped") return "■"
  return "○"
}

const phaseGlyph = (status: PhaseInfo["status"]): string => (status === "completed" ? "✓" : "●")

const agentColor = (status: AgentStatus): string => {
  if (status === "running") return theme.ok
  if (status === "failed") return theme.error
  if (status === "completed") return theme.text
  return theme.muted
}

/** Whole-second elapsed since started; if finished, the closed duration. */
function elapsed(time: { started: number; finished?: number }): string {
  const end = time.finished ?? Date.now()
  const seconds = Math.max(0, Math.round((end - time.started) / 1000))
  return `${seconds}s`
}

function clock(millis: number): string {
  const at = new Date(millis)
  return Number.isNaN(at.getTime()) ? "" : at.toISOString().slice(11, 19)
}

/** Compact one-line indicator for the most recent active run, above the prompt. */
export function ActiveRunLine(props: { run: RunSnapshot }) {
  // createMemo so the line tracks live snapshot updates; the component body runs
  // once in Solid, so reading agentProgress(props.run) directly would freeze it.
  const progress = createMemo(() => agentProgress(props.run))
  return (
    <box flexShrink={0} paddingLeft={1}>
      <text fg={theme.muted}>
        {statusGlyph(props.run.status)} workflow {props.run.name} · {progress().done}/{progress().total} agents ·{" "}
        {totalTokens(props.run.tokens)} tok
      </text>
    </box>
  )
}
