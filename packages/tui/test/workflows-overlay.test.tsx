/**
 * Component coverage for the M8 /workflows overlay:
 *
 * - /workflows opens the run list (status glyph, name, agents-done/total,
 *   tokens) seeded from the snapshot route
 * - Enter drills into the two-panel run view (phases left, the selected phase's
 *   agents right with model column) and into the agent detail (prompt head,
 *   model/variant, tokens)
 * - Esc backs out exactly one step, then closes from the list
 * - a live `session.workflow.updated` snapshot updates the open view
 * - `p` issues a pause control call against the run
 *
 * Drives the real prompt input and the mock fixture (the server routes are a
 * separate workstream), so this is the verification boundary for the overlay.
 */
import { afterEach, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { readAuthStatus } from "../src/api/auth"
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createGteApi } from "../src/api/gte"
import { createModelsApi } from "../src/api/models"
import { createWorkflowsApi } from "../src/api/workflows"
import { App } from "../src/ui/app"
import { createMockApi, makeRun, makeSession } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

let active: TestRendererSetup | undefined

afterEach(() => {
  if (active && !active.renderer.isDestroyed) active.renderer.destroy()
  active = undefined
})

/** A lone ESC sits ~20ms in the stdin disambiguation buffer; wait it out. */
async function pressEscape(setup: TestRendererSetup) {
  setup.mockInput.pressEscape()
  await new Promise((resolve) => setTimeout(resolve, 40))
}

async function mount(mock: ReturnType<typeof createMockApi>) {
  const setup = await testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        models={createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        workflows={createWorkflowsApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: mock.fetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        pollIntervalMs={40}
        onExit={() => {}}
      />
    ),
    { width: 140, height: 44 },
  )
  active = setup
  return setup
}

/** A two-phase run with fanned-out agents, used to exercise the two-panel view. */
const researchRun = () =>
  makeRun({
    id: "wfr_research",
    name: "deep-research",
    status: "running",
    tokens: { input: 1200, output: 800, reasoning: 0 },
    phases: [
      { name: "scan", status: "completed", agents: 2, tokens: { input: 600, output: 400, reasoning: 0 } },
      { name: "verify", status: "running", agents: 1, tokens: { input: 600, output: 400, reasoning: 0 } },
    ],
    agents: [
      {
        id: "a1",
        phase: "scan",
        prompt: "Survey ETH funding-rate history",
        model: "anthropic/claude-fable-5",
        variant: "xhigh",
        status: "completed",
        tokens: { input: 300, output: 200, reasoning: 0 },
        time: { started: 1_000, finished: 4_000 },
      },
      {
        id: "a2",
        phase: "scan",
        prompt: "Survey BTC funding-rate history",
        model: "anthropic/claude-fable-5",
        status: "running",
        tokens: { input: 300, output: 200, reasoning: 0 },
        time: { started: 1_000 },
      },
      {
        id: "a3",
        phase: "verify",
        prompt: "Cross-check the survey claims against sources",
        model: "anthropic/claude-fable-5",
        status: "running",
        tokens: { input: 600, output: 400, reasoning: 0 },
        time: { started: 2_000 },
      },
    ],
    logs: [{ time: 3_000, message: "scan phase complete" }],
  })

/** Mount with a seeded run, open the session, and open the /workflows overlay. */
async function openWorkflows(mock: ReturnType<typeof createMockApi>) {
  const setup = await mount(mock)
  await setup.waitForFrame((frame) => frame.includes("alpha session"))
  // Let any Esc still in the stdin disambiguation buffer from a prior test
  // drain before driving input, so it cannot merge with the keys below.
  await new Promise((resolve) => setTimeout(resolve, 50))
  setup.mockInput.pressKey("ARROW_DOWN")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  await setup.mockInput.typeText("/workflows")
  // A bare "/workflows" keeps the command dropdown open; wait for it, then Esc
  // dismisses only the dropdown (not the session) before Enter submits.
  await setup.waitForFrame((frame) => frame.includes("▸ /workflows"))
  await pressEscape(setup)
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("↑↓ move · enter open · esc close"))
  return setup
}

const seeded = () =>
  createMockApi({
    sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })],
    workflows: { ses_alpha: [researchRun()] },
  })

test("/workflows opens the run list seeded from the snapshot route; esc closes it", async () => {
  const setup = await openWorkflows(seeded())

  const list = await setup.waitForFrame((frame) => frame.includes("↑↓ move · enter open · esc close"))
  expect(list).toContain("deep-research")
  // Completed/total agents and token total in the row.
  expect(list).toContain("1/3 agents")
  expect(list).toContain("2000 tok")

  await pressEscape(setup)
  const closed = await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  expect(closed).not.toContain("↑↓ move · enter open")
})

test("drills list → two-panel run view → agent detail and backs out with esc", async () => {
  const setup = await openWorkflows(seeded())
  await setup.waitForFrame((frame) => frame.includes("deep-research"))

  // Enter the run view: two panels (phases + the selected phase's agents).
  setup.mockInput.pressEnter()
  const runView = await setup.waitForFrame((frame) => frame.includes("phases") && frame.includes("agents · scan"))
  expect(runView).toContain("1/3") // completed/total in the header
  expect(runView).toContain("scan")
  expect(runView).toContain("verify")
  // Selected phase is "scan": its two agents render with the model column.
  expect(runView).toContain("a1")
  expect(runView).toContain("a2")
  expect(runView).toContain("anthropic/claude-fable-5")
  // The persisted script path and a recent log line are shown.
  expect(runView).toContain("/tmp/workflow-runs/wfr_research.mjs")
  expect(runView).toContain("scan phase complete")

  // Enter the agent detail for the first agent of the selected phase.
  setup.mockInput.pressEnter()
  const detail = await setup.waitForFrame((frame) => frame.includes("Survey ETH funding-rate history"))
  expect(detail).toContain("a1")
  expect(detail).toContain("anthropic/claude-fable-5 (xhigh)")
  expect(detail).toContain("tokens: 300 in · 200 out")
  expect(detail).toContain("esc back · x stop agent")

  // Esc backs out one level to the run view, then to the list.
  await pressEscape(setup)
  const backToRun = await setup.waitForFrame((frame) => frame.includes("agents · scan"))
  expect(backToRun).not.toContain("esc back · x stop agent")
  await pressEscape(setup)
  const backToList = await setup.waitForFrame((frame) => frame.includes("↑↓ move · enter open · esc close"))
  expect(backToList).toContain("deep-research")
})

test("a live session.workflow.updated snapshot updates the open run view", async () => {
  const mock = seeded()
  const setup = await openWorkflows(mock)
  await setup.waitForFrame((frame) => frame.includes("deep-research"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("agents · scan"))

  // The run finishes: all agents complete, status flips.
  mock.emitWorkflow("ses_alpha", {
    ...researchRun(),
    status: "completed",
    agents: researchRun().agents.map((agent) => ({ ...agent, status: "completed" as const })),
  })
  const updated = await setup.waitForFrame((frame) => frame.includes("completed"))
  expect(updated).toContain("3/3")

  // Back out fully so the overlay's modal keypress listener is torn down before
  // the next test mounts (the @opentui test harness shares the key handler).
  await pressEscape(setup)
  await pressEscape(setup)
  await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
})

test("p pauses the active run through the control route", async () => {
  const mock = seeded()
  const setup = await openWorkflows(mock)
  await setup.waitForFrame((frame) => frame.includes("deep-research"))
  // Drill into the run view so `p` targets the pinned run.
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("agents · scan"))

  setup.mockInput.pressKey("p")
  await setup.waitFor(() => mock.controls.length > 0)
  expect(mock.controls[0]).toMatchObject({ sessionID: "ses_alpha", runID: "wfr_research", action: "pause" })
})

test("the active-run indicator surfaces above the prompt while a run is live", async () => {
  const mock = seeded()
  const setup = await mount(mock)
  await setup.waitForFrame((frame) => frame.includes("alpha session"))
  setup.mockInput.pressKey("ARROW_DOWN")
  setup.mockInput.pressEnter()
  const frame = await setup.waitForFrame((current) => current.includes("workflow deep-research"))
  expect(frame).toContain("1/3 agents")
})
