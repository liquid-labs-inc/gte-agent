/**
 * Pure state for the /workflows overlay (Milestone 8).
 *
 * Everything stateful lives in the overlay component; this module owns the
 * derivations and transitions so they stay unit-testable: seeding the run
 * registry from the list route, applying `session.workflow.updated` snapshot
 * envelopes (snapshot, not delta — the run replaces wholesale), the overlay
 * step machine (list → run → agent), selection movement that survives
 * snapshot churn, and the narrow-terminal stacking helper.
 *
 * Wire note: the workflow schema encodes every time field through
 * `DateTimeUtcFromMillis`, so over the SSE stream and the HTTP routes all
 * `time.*` and `logs[].time` values arrive as epoch-millisecond numbers.
 */
import type { SessionEventEnvelope } from "../api/events"

export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped"
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "stopped"
export type PhaseStatus = "running" | "completed"

export type Tokens = { readonly input: number; readonly output: number; readonly reasoning: number }

export type AgentInfo = {
  readonly id: string
  readonly phase: string
  readonly prompt: string
  /** Effective "providerID/modelID" once settled; may differ from the requested model on fallback. */
  readonly model?: string
  readonly variant?: string
  /** What the script asked for; a parallel workstream lands these, so read them optionally. */
  readonly requestedModel?: string
  readonly requestedVariant?: string
  readonly sessionID?: string
  readonly status: AgentStatus
  readonly tokens: Tokens
  readonly error?: string
  readonly time: { readonly started: number; readonly finished?: number }
}

export type PhaseInfo = {
  readonly name: string
  readonly status: PhaseStatus
  readonly agents: number
  readonly tokens: Tokens
  /** Phase wall-clock; a parallel workstream lands this, so read it optionally. */
  readonly time?: { readonly started: number; readonly finished?: number }
}

export type LogLine = { readonly time: number; readonly message: string }

export type RunSnapshot = {
  readonly id: string
  readonly sessionID: string
  readonly name: string
  readonly status: RunStatus
  readonly scriptPath: string
  readonly tokens: Tokens
  readonly time: { readonly started: number; readonly finished?: number }
  readonly phases: readonly PhaseInfo[]
  readonly agents: readonly AgentInfo[]
  readonly logs: readonly LogLine[]
  /** Intended agent count; a parallel workstream lands this, so prefer it over the observed count when present. */
  readonly agentTotal?: number
  readonly result?: string
  readonly error?: string
}

const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["running", "paused"])

export const isActiveRun = (run: RunSnapshot): boolean => ACTIVE_STATUSES.has(run.status)

const completedAgents = (run: RunSnapshot): number => run.agents.filter((agent) => agent.status === "completed").length

/** Sum of all three token buckets — the single number shown in compact stats. */
export const totalTokens = (tokens: Tokens): number => tokens.input + tokens.output + tokens.reasoning

/**
 * Agents-done / agent-total pair used in the list row and run header. `total`
 * prefers the run's intended `agentTotal` when present (a script may declare
 * more agents than have spawned so far), falling back to the observed count.
 */
export function agentProgress(run: RunSnapshot): { readonly done: number; readonly total: number } {
  const total = typeof run.agentTotal === "number" ? Math.max(run.agentTotal, run.agents.length) : run.agents.length
  return { done: completedAgents(run), total }
}

/** Run registry: newest run first (ascending ids sort newest last, so reverse). */
export type WorkflowsState = { readonly runs: readonly RunSnapshot[] }

export const emptyWorkflows: WorkflowsState = { runs: [] }

const sortedNewestFirst = (runs: readonly RunSnapshot[]): RunSnapshot[] =>
  [...runs].sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))

/** Seed the registry from the list route (order-independent input). */
export function seedWorkflows(runs: readonly RunSnapshot[]): WorkflowsState {
  return { runs: sortedNewestFirst(runs) }
}

/**
 * Apply a `session.workflow.updated` envelope. Snapshot semantics: the run with
 * the incoming id is replaced wholesale (or inserted), and the registry stays
 * sorted newest-first so the list view is stable across updates.
 */
export function applyWorkflowEvent(state: WorkflowsState, envelope: SessionEventEnvelope): WorkflowsState {
  if (envelope.event.type !== "session.workflow.updated") return state
  const run = envelope.event.data["run"] as RunSnapshot | undefined
  if (run === undefined || typeof run.id !== "string") return state
  const others = state.runs.filter((candidate) => candidate.id !== run.id)
  return { runs: sortedNewestFirst([run, ...others]) }
}

/** True when the envelope belongs to the workflows reducer, not the transcript. */
export function isWorkflowEvent(type: string): boolean {
  return type === "session.workflow.updated"
}

export const findRun = (state: WorkflowsState, runID: string): RunSnapshot | undefined =>
  state.runs.find((run) => run.id === runID)

export const activeRuns = (state: WorkflowsState): readonly RunSnapshot[] => state.runs.filter(isActiveRun)

/**
 * Overlay step machine. `list` indexes the run registry; `run` pins a run id
 * and a phase index; `agent` pins a run id and an agent id. Ids (not indices)
 * pin the run/agent so a snapshot reordering the registry cannot drift the
 * drilled-in view onto a different run.
 */
export type WorkflowStep =
  | { readonly kind: "list"; readonly selected: number }
  | { readonly kind: "run"; readonly runID: string; readonly phase: number }
  | { readonly kind: "agent"; readonly runID: string; readonly agentID: string }

export const initialStep: WorkflowStep = { kind: "list", selected: 0 }

/** Wrap-around highlight movement, shared with the models overlay convention. */
export function moveStep(state: WorkflowsState, step: WorkflowStep, delta: number): WorkflowStep {
  if (step.kind === "list") {
    const count = state.runs.length
    if (count <= 0) return { kind: "list", selected: 0 }
    return { kind: "list", selected: (step.selected + delta + count) % count }
  }
  if (step.kind === "run") {
    const run = findRun(state, step.runID)
    const count = run?.phases.length ?? 0
    if (count <= 0) return step
    return { kind: "run", runID: step.runID, phase: (step.phase + delta + count) % count }
  }
  const run = findRun(state, step.runID)
  const agents = phaseAgents(run, agentPhase(run, step.agentID))
  if (agents.length <= 1) return step
  const index = agents.findIndex((agent) => agent.id === step.agentID)
  const next = ((index < 0 ? 0 : index) + delta + agents.length) % agents.length
  return { kind: "agent", runID: step.runID, agentID: agents[next].id }
}

/**
 * Drill one level deeper: list → run (selected run), run → agent (first agent
 * of the selected phase). Returns the same step when there is nothing to enter
 * (empty list, a phase with no agents, or already at agent depth).
 */
export function enterStep(state: WorkflowsState, step: WorkflowStep): WorkflowStep {
  if (step.kind === "list") {
    const run = state.runs[step.selected]
    if (run === undefined) return step
    return { kind: "run", runID: run.id, phase: 0 }
  }
  if (step.kind === "run") {
    const run = findRun(state, step.runID)
    const phase = run?.phases[step.phase]
    if (run === undefined || phase === undefined) return step
    const agents = phaseAgents(run, phase.name)
    if (agents.length === 0) return step
    return { kind: "agent", runID: step.runID, agentID: agents[0].id }
  }
  return step
}

/**
 * Back out one level: agent → run (re-pin the phase the agent belongs to),
 * run → list (re-select the run by index). Returns undefined from the list
 * step so the caller closes the overlay.
 */
export function backStep(state: WorkflowsState, step: WorkflowStep): WorkflowStep | undefined {
  if (step.kind === "agent") {
    const run = findRun(state, step.runID)
    const phaseName = agentPhase(run, step.agentID)
    const phase = run === undefined ? -1 : run.phases.findIndex((candidate) => candidate.name === phaseName)
    return { kind: "run", runID: step.runID, phase: phase < 0 ? 0 : phase }
  }
  if (step.kind === "run") {
    const index = state.runs.findIndex((run) => run.id === step.runID)
    return { kind: "list", selected: index < 0 ? 0 : index }
  }
  return undefined
}

/** The run the current step targets, if any (run/agent steps); undefined at the list step. */
export function stepRun(state: WorkflowsState, step: WorkflowStep): RunSnapshot | undefined {
  if (step.kind === "list") return undefined
  return findRun(state, step.runID)
}

/** Agents belonging to a phase, in snapshot order. */
export function phaseAgents(run: RunSnapshot | undefined, phaseName: string | undefined): readonly AgentInfo[] {
  if (run === undefined || phaseName === undefined) return []
  return run.agents.filter((agent) => agent.phase === phaseName)
}

/** The agent the current step targets, undefined unless at the agent step. */
export function stepAgent(state: WorkflowsState, step: WorkflowStep): AgentInfo | undefined {
  if (step.kind !== "agent") return undefined
  const run = findRun(state, step.runID)
  return run?.agents.find((agent) => agent.id === step.agentID)
}

const agentPhase = (run: RunSnapshot | undefined, agentID: string): string | undefined =>
  run?.agents.find((agent) => agent.id === agentID)?.phase

/** Two-panel layouts stack vertically below this width; matches the data-workspace cutoff. */
export const NARROW_COLUMNS = 100

export const isNarrow = (columns: number): boolean => columns < NARROW_COLUMNS
