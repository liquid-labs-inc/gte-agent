// End-to-end demo required by ULTRATHINK-SPEC.md: a two-phase workflow run
// with a stubbed agent executor proving phases, the parallelism cap, result
// caching (pause/resume replay), and result delivery through the real
// Bun-Worker-backed WorkflowRun.
import { describe, expect, test } from "bun:test"
import { WorkflowRun } from "@/workflow/run"
import type { AgentExecutor, WorkflowEvent } from "@/workflow/run"

const SCRIPT = `
log("kicking off")
const angles = await phase("plan", async () => {
  const r = await agent({ prompt: "list-angles" })
  return r.text.split(",")
})
const results = await phase("research", async () => {
  const out = await map(angles, (angle) => agent({ prompt: "research:" + angle }), { concurrency: 3 })
  // duplicate of a completed prompt in the same phase: must replay from the
  // (phase, prompt-hash) cache, not re-execute
  const again = await agent({ prompt: "research:a" })
  return [...out, again]
})
return results.map((r) => r.text).join("|")
`

describe("workflow demo (spec verification)", () => {
  test("two-phase demo: phases, concurrency cap, caching, result delivery", async () => {
    let active = 0
    let peak = 0
    let calls = 0
    const executor: AgentExecutor = async (request) => {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      if (request.prompt === "list-angles") return { text: "a,b,c", tokens: { input: 4, output: 4 } }
      return { text: `R(${request.prompt})`, tokens: { input: 2, output: 2 } }
    }

    const events: WorkflowEvent[] = []
    const run = new WorkflowRun({
      id: "wf_demo",
      name: "demo-research",
      script: SCRIPT,
      executor,
      maxConcurrent: 2,
      emit: (event) => events.push(event),
    })
    run.start()
    const result = await run.done

    expect(result.status).toBe("completed")
    expect(result.result).toBe("R(research:a)|R(research:b)|R(research:c)|R(research:a)")
    // 1 planner + 3 research agents; the repeated "research:a" was cached
    expect(calls).toBe(4)
    expect(peak).toBeLessThanOrEqual(2)

    const snapshot = run.snapshot()
    expect(snapshot.status).toBe("completed")
    expect(snapshot.phases.map((phase) => phase.name)).toEqual(["plan", "research"])
    expect(snapshot.phases.every((phase) => phase.status === "completed")).toBe(true)
    expect(snapshot.logs.map((line) => line.message)).toEqual(["kicking off"])
    // 4 executed agent records; the cached recheck is answered from the cache
    expect(snapshot.agents).toHaveLength(4)

    const types = events.map((event) => event.type)
    expect(types[0]).toBe("run.started")
    expect(types.at(-1)).toBe("run.finished")
    expect(types).toContain("phase.started")
    expect(types).toContain("agent.started")
    expect(types).toContain("agent.finished")
    expect(types).toContain("log")
  })

  test("pause stops the worker, resume replays completed agents from cache", async () => {
    let calls = 0
    const slow: AgentExecutor = async (request) => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { text: `done:${request.prompt}`, tokens: { input: 1, output: 1 } }
    }
    const run = new WorkflowRun({
      id: "wf_demo_pause",
      name: "pausable",
      script: `
        const one = await agent({ prompt: "one" })
        const two = await agent({ prompt: "two" })
        return one.text + "," + two.text
      `,
      executor: slow,
      maxConcurrent: 2,
    })
    run.start()
    // let the first agent finish, then pause mid-run
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(run.pause()).toBe(true)
    expect(run.currentStatus).toBe("paused")
    const callsAtPause = calls
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(run.resume()).toBe(true)
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("done:one,done:two")
    // resume re-executes the script; completed agents replay from cache
    // (at most one extra execution for the agent that was in flight at pause)
    expect(calls).toBeLessThanOrEqual(callsAtPause + 1)
  })

  test("total agent cap fails the run with a clear error", async () => {
    const executor: AgentExecutor = async () => ({ text: "x", tokens: { input: 0, output: 0 } })
    const run = new WorkflowRun({
      id: "wf_demo_cap",
      name: "cap",
      script: `await map([1, 2, 3, 4], (n) => agent({ prompt: "p" + n })); return "no"`,
      executor,
      maxConcurrent: 2,
      maxAgents: 2,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("error")
    expect(result.error).toContain("limit")
  })
})
