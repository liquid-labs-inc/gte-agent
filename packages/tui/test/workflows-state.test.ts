/**
 * Pure-reducer coverage for the /workflows state module (Milestone 8):
 *
 * - seeding sorts the registry newest-first (ascending ids reversed)
 * - `session.workflow.updated` replaces a run wholesale (snapshot, not delta)
 *   and inserts unknown runs, keeping the registry sorted
 * - non-workflow envelopes pass through untouched
 * - `agentProgress` counts completed agents and prefers the optional
 *   `agentTotal` when a parallel workstream lands it
 * - the step machine drills list → run → agent and backs out one level, with
 *   ids (not indices) pinning the drilled-in run/agent so a snapshot reordering
 *   the registry cannot drift the view
 * - selection movement wraps and survives an empty/short list
 */
import { describe, expect, test } from "bun:test"
import type { SessionEventEnvelope } from "../src/api/events"
import {
  activeRuns,
  agentProgress,
  applyWorkflowEvent,
  backStep,
  enterStep,
  findRun,
  initialStep,
  isActiveRun,
  isNarrow,
  isWorkflowEvent,
  moveStep,
  phaseAgents,
  seedWorkflows,
  stepAgent,
  stepRun,
  totalTokens,
  type AgentInfo,
  type RunSnapshot,
  type WorkflowStep,
} from "../src/state/workflows"

const noTokens = { input: 0, output: 0, reasoning: 0 }

function makeRun(input: Partial<RunSnapshot> & { id: string }): RunSnapshot {
  return {
    sessionID: "ses_alpha",
    name: input.id,
    status: "running",
    scriptPath: `/tmp/workflow-runs/${input.id}.mjs`,
    tokens: noTokens,
    time: { started: 1_000 },
    phases: [],
    agents: [],
    logs: [],
    ...input,
  }
}

const agent = (id: string, phase: string, extra?: Partial<AgentInfo>): AgentInfo => ({
  id,
  phase,
  prompt: `prompt ${id}`,
  status: "running",
  tokens: noTokens,
  time: { started: 1_000 },
  ...extra,
})

const updatedEnvelope = (run: RunSnapshot): SessionEventEnvelope => ({
  event: { id: `evt_${run.id}`, type: "session.workflow.updated", data: { sessionID: run.sessionID, run } },
})

describe("seedWorkflows", () => {
  test("sorts the registry newest-first by ascending run id", () => {
    const state = seedWorkflows([makeRun({ id: "wfr_a" }), makeRun({ id: "wfr_c" }), makeRun({ id: "wfr_b" })])
    expect(state.runs.map((run) => run.id)).toEqual(["wfr_c", "wfr_b", "wfr_a"])
  })

  test("empty input yields an empty registry", () => {
    expect(seedWorkflows([]).runs).toEqual([])
  })
})

describe("applyWorkflowEvent", () => {
  test("replaces a run wholesale by id and keeps newest-first order", () => {
    const state = seedWorkflows([makeRun({ id: "wfr_a", status: "running" }), makeRun({ id: "wfr_b" })])
    const next = applyWorkflowEvent(state, updatedEnvelope(makeRun({ id: "wfr_a", status: "completed" })))
    expect(next.runs.map((run) => run.id)).toEqual(["wfr_b", "wfr_a"])
    expect(findRun(next, "wfr_a")?.status).toBe("completed")
    expect(next.runs.length).toBe(2)
  })

  test("inserts an unknown run", () => {
    const state = seedWorkflows([makeRun({ id: "wfr_a" })])
    const next = applyWorkflowEvent(state, updatedEnvelope(makeRun({ id: "wfr_b" })))
    expect(next.runs.map((run) => run.id)).toEqual(["wfr_b", "wfr_a"])
  })

  test("ignores non-workflow envelopes and malformed runs", () => {
    const state = seedWorkflows([makeRun({ id: "wfr_a" })])
    const other: SessionEventEnvelope = { event: { id: "evt_x", type: "session.intent.updated", data: {} } }
    expect(applyWorkflowEvent(state, other)).toBe(state)
    const malformed: SessionEventEnvelope = {
      event: { id: "evt_y", type: "session.workflow.updated", data: { run: { name: "no id" } } },
    }
    expect(applyWorkflowEvent(state, malformed)).toBe(state)
  })

  test("isWorkflowEvent recognizes only the updated event", () => {
    expect(isWorkflowEvent("session.workflow.updated")).toBe(true)
    expect(isWorkflowEvent("session.panel.updated")).toBe(false)
  })
})

describe("derivations", () => {
  test("totalTokens sums all three buckets", () => {
    expect(totalTokens({ input: 3, output: 5, reasoning: 2 })).toBe(10)
  })

  test("agentProgress counts completed and uses the observed count when agentTotal is absent", () => {
    const run = makeRun({
      id: "wfr_a",
      agents: [agent("a1", "p", { status: "completed" }), agent("a2", "p", { status: "running" })],
    })
    expect(agentProgress(run)).toEqual({ done: 1, total: 2 })
  })

  test("agentProgress prefers agentTotal once a parallel workstream lands it", () => {
    const run = makeRun({
      id: "wfr_a",
      agentTotal: 8,
      agents: [agent("a1", "p", { status: "completed" })],
    })
    expect(agentProgress(run)).toEqual({ done: 1, total: 8 })
  })

  test("isActiveRun / activeRuns cover running and paused only", () => {
    const state = seedWorkflows([
      makeRun({ id: "wfr_a", status: "running" }),
      makeRun({ id: "wfr_b", status: "completed" }),
      makeRun({ id: "wfr_c", status: "paused" }),
    ])
    expect(activeRuns(state).map((run) => run.id)).toEqual(["wfr_c", "wfr_a"])
    expect(isActiveRun(makeRun({ id: "wfr_d", status: "stopped" }))).toBe(false)
  })

  test("phaseAgents filters by phase name in snapshot order", () => {
    const run = makeRun({
      id: "wfr_a",
      agents: [agent("a1", "scan"), agent("a2", "verify"), agent("a3", "scan")],
    })
    expect(phaseAgents(run, "scan").map((item) => item.id)).toEqual(["a1", "a3"])
    expect(phaseAgents(run, undefined)).toEqual([])
  })

  test("isNarrow honors the stacking cutoff", () => {
    expect(isNarrow(80)).toBe(true)
    expect(isNarrow(120)).toBe(false)
  })
})

describe("step machine", () => {
  const state = seedWorkflows([
    makeRun({
      id: "wfr_b",
      phases: [
        { name: "scan", status: "completed", agents: 2, tokens: noTokens },
        { name: "verify", status: "running", agents: 1, tokens: noTokens },
      ],
      agents: [agent("a1", "scan"), agent("a2", "scan"), agent("a3", "verify")],
    }),
    makeRun({ id: "wfr_a" }),
  ])

  test("moveStep wraps the list selection", () => {
    expect(moveStep(state, { kind: "list", selected: 0 }, 1)).toEqual({ kind: "list", selected: 1 })
    expect(moveStep(state, { kind: "list", selected: 1 }, 1)).toEqual({ kind: "list", selected: 0 })
  })

  test("enter drills list → run → agent (first agent of the selected phase)", () => {
    const runStep = enterStep(state, initialStep)
    expect(runStep).toEqual({ kind: "run", runID: "wfr_b", phase: 0 })
    const agentStep = enterStep(state, runStep)
    expect(agentStep).toEqual({ kind: "agent", runID: "wfr_b", agentID: "a1" })
    // Agent depth is terminal.
    expect(enterStep(state, agentStep)).toEqual(agentStep)
  })

  test("moveStep at the run step wraps the phase index", () => {
    expect(moveStep(state, { kind: "run", runID: "wfr_b", phase: 0 }, 1)).toEqual({
      kind: "run",
      runID: "wfr_b",
      phase: 1,
    })
  })

  test("moveStep at the agent step walks the selected phase's agents", () => {
    const step: WorkflowStep = { kind: "agent", runID: "wfr_b", agentID: "a1" }
    expect(moveStep(state, step, 1)).toEqual({ kind: "agent", runID: "wfr_b", agentID: "a2" })
  })

  test("back climbs agent → run (re-pins the agent's phase) → list (re-selects the run)", () => {
    const fromAgent = backStep(state, { kind: "agent", runID: "wfr_b", agentID: "a3" })
    expect(fromAgent).toEqual({ kind: "run", runID: "wfr_b", phase: 1 })
    const fromRun = backStep(state, { kind: "run", runID: "wfr_b", phase: 1 })
    expect(fromRun).toEqual({ kind: "list", selected: 0 })
    expect(backStep(state, { kind: "list", selected: 0 })).toBeUndefined()
  })

  test("ids pin the drilled-in run so a snapshot reordering the registry does not drift the view", () => {
    const step: WorkflowStep = { kind: "run", runID: "wfr_a", phase: 0 }
    // A new run sorts ahead of wfr_a, shifting its index; the step still resolves wfr_a.
    const reordered = applyWorkflowEvent(state, updatedEnvelope(makeRun({ id: "wfr_z" })))
    expect(stepRun(reordered, step)?.id).toBe("wfr_a")
    // Backing out re-selects wfr_a at its new index (now 1, after wfr_z and wfr_b? no — wfr_z newest).
    expect(backStep(reordered, step)).toEqual({
      kind: "list",
      selected: reordered.runs.findIndex((r) => r.id === "wfr_a"),
    })
  })

  test("stepRun / stepAgent resolve the targeted run and agent", () => {
    expect(stepRun(state, initialStep)).toBeUndefined()
    expect(stepAgent(state, { kind: "agent", runID: "wfr_b", agentID: "a2" })?.id).toBe("a2")
    expect(stepAgent(state, initialStep)).toBeUndefined()
  })
})
