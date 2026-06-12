import { describe, expect, test } from "bun:test"
import { WorkflowRun, contentKey, defaultConcurrency, renderResult } from "@/workflow/run"
import type { AgentExecutor, WorkflowEvent } from "@/workflow/run"

let seq = 0
function makeRun(input: {
  script: string
  args?: unknown
  executor: AgentExecutor
  emit?: (event: WorkflowEvent) => void
  maxConcurrent?: number
  maxAgents?: number
}) {
  return new WorkflowRun({
    id: `wf_test_${++seq}`,
    name: "test",
    script: input.script,
    args: input.args,
    executor: input.executor,
    emit: input.emit,
    maxConcurrent: input.maxConcurrent ?? 4,
    maxAgents: input.maxAgents,
  })
}

const echoExecutor: AgentExecutor = async (request) => ({
  text: `echo:${request.prompt}`,
  tokens: { input: 10, output: 5 },
})

describe("workflow run", () => {
  test("runs phases and agents, delivers result", async () => {
    const events: WorkflowEvent[] = []
    const run = makeRun({
      script: `
        const found = await phase("investigate", () => agent({ prompt: "look around" }))
        log("found: " + found.text)
        const checked = await phase("verify", () => agent({ prompt: "verify " + found.text }))
        return checked.text
      `,
      executor: echoExecutor,
      emit: (event) => events.push(event),
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("echo:verify echo:look around")

    const snapshot = run.snapshot()
    expect(snapshot.status).toBe("completed")
    expect(snapshot.phases.map((p) => p.name)).toEqual(["investigate", "verify"])
    expect(snapshot.agents).toHaveLength(2)
    expect(snapshot.tokens).toEqual({ input: 20, output: 10 })
    expect(snapshot.logs.map((l) => l.message)).toEqual(["found: echo:look around"])

    const types = events.map((event) => event.type)
    expect(types[0]).toBe("run.started")
    expect(types).toContain("phase.started")
    expect(types).toContain("agent.started")
    expect(types).toContain("agent.finished")
    expect(types).toContain("log")
    expect(types[types.length - 1]).toBe("run.finished")
  }, 20000)

  test("map fans out with bounded concurrency and runtime cap", async () => {
    let inflight = 0
    let peak = 0
    const executor: AgentExecutor = async (request) => {
      inflight++
      peak = Math.max(peak, inflight)
      await new Promise((resolve) => setTimeout(resolve, 25))
      inflight--
      return { text: `done:${request.prompt}`, tokens: { input: 1, output: 1 } }
    }
    const run = makeRun({
      script: `
        const items = [0, 1, 2, 3, 4, 5, 6, 7]
        const out = await phase("fan", () => map(items, (n) => agent({ prompt: "item " + n }), { concurrency: 8 }))
        return out.map((r) => r.text).join(",")
      `,
      executor,
      maxConcurrent: 2,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(peak).toBeLessThanOrEqual(2)
    expect(result.result).toBe(
      [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `done:item ${n}`).join(","),
    )
  }, 20000)

  test("map preserves order and passes index", async () => {
    const run = makeRun({
      script: `
        const out = await map(["a", "b", "c"], (item, i) => agent({ prompt: item + i }), { concurrency: 2 })
        return out.map((r) => r.text)
      `,
      executor: echoExecutor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(JSON.parse(result.result!)).toEqual(["echo:a0", "echo:b1", "echo:c2"])
  }, 20000)

  test("args are passed as structured data; absent args are undefined", async () => {
    const run = makeRun({
      script: `return { got: args.items.length, first: args.items[0] }`,
      args: { items: [1, 2, 3] },
      executor: echoExecutor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(JSON.parse(result.result!)).toEqual({ got: 3, first: 1 })

    const noArgs = makeRun({ script: `return typeof args`, executor: echoExecutor })
    noArgs.start()
    const second = await noArgs.done
    expect(second.result).toBe("undefined")
  }, 20000)

  test("total agent cap rejects further spawns", async () => {
    const run = makeRun({
      script: `
        try {
          await map([1, 2, 3, 4], (n) => agent({ prompt: "p" + n }), { concurrency: 1 })
          return "no limit hit"
        } catch (error) {
          return "limit: " + error.message
        }
      `,
      executor: echoExecutor,
      maxAgents: 2,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toContain("limit:")
    expect(result.result).toContain("2 agents per run")
  }, 20000)

  test("script sandbox: no fs, shell, network, or process access", async () => {
    const run = makeRun({
      script: `
        return {
          bun: typeof Bun,
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
          websocket: typeof WebSocket,
          worker: typeof Worker,
        }
      `,
      executor: echoExecutor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(JSON.parse(result.result!)).toEqual({
      bun: "undefined",
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      websocket: "undefined",
      worker: "undefined",
    })
  }, 20000)

  test("script errors fail the run", async () => {
    const run = makeRun({
      script: `throw new Error("boom from script")`,
      executor: echoExecutor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("error")
    expect(result.error).toContain("boom from script")
  }, 20000)

  test("agent failures reject the script-side promise", async () => {
    const executor: AgentExecutor = async (request) => {
      if (request.prompt.includes("bad")) throw new Error("agent exploded")
      return { text: "ok", tokens: { input: 1, output: 1 } }
    }
    const run = makeRun({
      script: `
        try {
          await agent({ prompt: "bad one" })
          return "unexpected"
        } catch (error) {
          return "caught: " + error.message
        }
      `,
      executor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("caught: agent exploded")
  }, 20000)

  test("identical (phase, prompt) requests are served from the result cache", async () => {
    let calls = 0
    const executor: AgentExecutor = async (request) => {
      calls++
      return { text: `r:${request.prompt}`, tokens: { input: 1, output: 1 } }
    }
    const run = makeRun({
      script: `
        const first = await phase("p", () => agent({ prompt: "same" }))
        const second = await phase("p", () => agent({ prompt: "same" }))
        return first.text + "|" + second.text
      `,
      executor,
    })
    run.start()
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("r:same|r:same")
    expect(calls).toBe(1)
  }, 20000)

  test("cancel stops the run and aborts in-flight agents", async () => {
    let aborted = false
    const executor: AgentExecutor = (request, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      })
    const run = makeRun({
      script: `await agent({ prompt: "long task" }); return "never"`,
      executor,
    })
    run.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(run.cancel()).toBe(true)
    const result = await run.done
    expect(result.status).toBe("cancelled")
    expect(aborted).toBe(true)
  }, 20000)

  test("pause stops new spawns; resume replays cached agents instantly", async () => {
    const calls: string[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const executor: AgentExecutor = async (request, signal) => {
      calls.push(`${request.prompt}#${request.attempt}`)
      if (request.prompt === "second" && calls.filter((c) => c.startsWith("second")).length === 1) {
        // first attempt at "second" blocks until aborted by pause
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")))
          void gate.then(() => reject(new Error("aborted")))
        })
      }
      return { text: `r:${request.prompt}`, tokens: { input: 1, output: 1 } }
    }
    const events: WorkflowEvent[] = []
    const run = makeRun({
      script: `
        const one = await phase("a", () => agent({ prompt: "first" }))
        const two = await phase("b", () => agent({ prompt: "second" }))
        return one.text + "|" + two.text
      `,
      executor,
      emit: (event) => events.push(event),
    })
    run.start()
    // wait until the second agent is in flight
    while (!calls.some((c) => c.startsWith("second"))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(run.pause()).toBe(true)
    expect(run.currentStatus).toBe("paused")
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 50))

    const firstCalls = calls.filter((c) => c.startsWith("first")).length
    expect(firstCalls).toBe(1)

    expect(run.resume()).toBe(true)
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("r:first|r:second")
    // "first" was cached — never re-executed after resume
    expect(calls.filter((c) => c.startsWith("first")).length).toBe(1)
    // "second" was re-executed on resume
    expect(calls.filter((c) => c.startsWith("second")).length).toBe(2)
    expect(events.some((e) => e.type === "run.updated" && e.status === "paused")).toBe(true)
    expect(events.some((e) => e.type === "run.updated" && e.status === "running")).toBe(true)
  }, 20000)

  test("restartAgent re-executes the selected agent", async () => {
    let attempts = 0
    let sawRestart = false
    const executor: AgentExecutor = async (request, signal) => {
      attempts++
      if (attempts === 1) {
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        })
      }
      if (request.attempt > 1) sawRestart = true
      return { text: "final", tokens: { input: 1, output: 1 } }
    }
    const run = makeRun({
      script: `const r = await agent({ prompt: "restartable" }); return r.text`,
      executor,
    })
    run.start()
    while (attempts === 0) await new Promise((resolve) => setTimeout(resolve, 10))
    const agentID = run.snapshot().agents[0].id
    expect(run.restartAgent(agentID)).toBe(true)
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("final")
    expect(attempts).toBe(2)
    expect(sawRestart).toBe(true)
  }, 20000)

  test("stopAgent cancels just that agent", async () => {
    const executor: AgentExecutor = (request, signal) =>
      new Promise((resolve, reject) => {
        if (request.prompt === "fast") {
          resolve({ text: "fast done", tokens: { input: 1, output: 1 } })
          return
        }
        signal.addEventListener("abort", () => reject(new Error("stopped")))
      })
    const run = makeRun({
      script: `
        const results = await Promise.allSettled([
          agent({ prompt: "fast" }),
          agent({ prompt: "slow" }),
        ])
        return results.map((r) => r.status).join(",")
      `,
      executor,
    })
    run.start()
    while (run.snapshot().agents.length < 2) await new Promise((resolve) => setTimeout(resolve, 10))
    const slow = run.snapshot().agents.find((agent) => agent.prompt === "slow")!
    expect(run.stopAgent(slow.id)).toBe(true)
    const result = await run.done
    expect(result.status).toBe("completed")
    expect(result.result).toBe("fulfilled,rejected")
    const final = run.snapshot().agents.find((agent) => agent.prompt === "slow")!
    expect(final.status).toBe("cancelled")
  }, 20000)
})

describe("helpers", () => {
  test("defaultConcurrency respects core counts", () => {
    expect(defaultConcurrency(32)).toBe(16)
    expect(defaultConcurrency(8)).toBe(6)
    expect(defaultConcurrency(2)).toBe(2)
    expect(defaultConcurrency(1)).toBe(2)
  })

  test("contentKey is stable per phase and options", () => {
    expect(contentKey("p", { prompt: "x" })).toBe(contentKey("p", { prompt: "x" }))
    expect(contentKey("p", { prompt: "x" })).not.toBe(contentKey("q", { prompt: "x" }))
    expect(contentKey("p", { prompt: "x" })).not.toBe(contentKey("p", { prompt: "x", variant: "high" }))
  })

  test("renderResult stringifies structured results", () => {
    expect(renderResult("plain")).toBe("plain")
    expect(renderResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2))
    expect(renderResult(undefined)).toBe("")
  })
})
