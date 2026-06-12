import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { Global } from "@gte-agent/core/global"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { WorkflowEvent } from "@gte-agent/core/workflow/event"
import { WorkflowExecutor } from "@gte-agent/core/workflow/executor"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_workflow_runtime")

/**
 * Every test drives the real runtime (real Bun worker, real sandbox) against a
 * stubbed agent executor, composed per test so each gets a fresh in-memory
 * database and its own temporary data dir for script persistence.
 */
const harness = <A, E>(
  executor: WorkflowExecutor.Interface["execute"],
  body: (data: string) => Effect.Effect<A, E, WorkflowRuntime.Service | Event.Service>,
  options?: WorkflowRuntime.Options,
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const database = Database.layerFromPath(":memory:")
    const events = Event.layer.pipe(Layer.provide(database))
    const runtime = WorkflowRuntime.layerWith(options ?? { snapshotTickMs: 20 }).pipe(
      Layer.provide(events),
      Layer.provide(Global.layerWith({ data: tmp.path })),
      Layer.provide(Layer.succeed(WorkflowExecutor.Service, WorkflowExecutor.Service.of({ execute: executor }))),
    )
    return yield* body(tmp.path).pipe(Effect.provide(Layer.mergeAll(runtime, events)))
  })

const echo: WorkflowExecutor.Interface["execute"] = (request) =>
  Effect.succeed({ text: `${request.prompt}:ok`, tokens: { input: 1, output: 2, reasoning: 0 } })

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

const waitUntil = (predicate: Effect.Effect<boolean>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* predicate)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("waitUntil timed out"))
      yield* sleep(10)
    }
  })

describe("WorkflowRuntime", () => {
  it.live("caps follow min(16, max(2, cores - 2)) and 1000 agents per run", () =>
    Effect.sync(() => {
      expect(WorkflowRuntime.concurrencyCap(2)).toBe(2)
      expect(WorkflowRuntime.concurrencyCap(4)).toBe(2)
      expect(WorkflowRuntime.concurrencyCap(8)).toBe(6)
      expect(WorkflowRuntime.concurrencyCap(18)).toBe(16)
      expect(WorkflowRuntime.concurrencyCap(64)).toBe(16)
      expect(WorkflowRuntime.MAX_AGENTS_PER_RUN).toBe(1000)
    }),
  )

  it.live("runs phases, fans out agents, and delivers the script result", () =>
    harness(echo, (data) =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({
          sessionID,
          name: "phases",
          script: [
            'const research = await phase("research", () =>',
            '  map(args.items, (item) => agent({ prompt: "research " + item })),',
            ")",
            'log("research complete")',
            'const summary = await phase("synthesize", () =>',
            '  agent({ prompt: "synthesize " + research.map((item) => item.text).join("+") }),',
            ")",
            "return summary.text",
          ].join("\n"),
          args: { items: ["a", "b", "c"] },
        })
        expect(started.scriptPath).toStartWith(data)
        expect(started.scriptPath).toEndWith(`workflow-runs/${started.id}.mjs`)
        const finished = yield* runtime.wait(started.id)
        expect(finished?.status).toBe("completed")
        expect(finished?.result).toBe("synthesize research a:ok+research b:ok+research c:ok:ok")
        expect(finished?.phases).toMatchObject([
          { name: "research", status: "completed", agents: 3, tokens: { input: 3, output: 6, reasoning: 0 } },
          { name: "synthesize", status: "completed", agents: 1, tokens: { input: 1, output: 2, reasoning: 0 } },
        ])
        expect(finished?.agents.map((agent) => agent.status)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
        ])
        expect(finished?.tokens).toEqual({ input: 4, output: 8, reasoning: 0 })
        expect(finished?.logs.map((line) => line.message)).toEqual(["research complete"])
        // Completed/total comes straight off the snapshot; cache hits never count.
        expect(finished?.agentTotal).toBe(4)
        // Each phase carries its own elapsed window for the TUI.
        for (const phase of finished?.phases ?? []) {
          expect(DateTime.toEpochMillis(phase.time.started)).toBeGreaterThanOrEqual(0)
          expect(phase.time.finished).toBeDefined()
        }
      }),
    ),
  )

  it.live("persists the script to <data>/workflow-runs/<runID>.mjs", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const script = 'return (await agent({ prompt: "hello" })).text'
        const started = yield* runtime.start({ sessionID, name: "persist", script })
        expect(yield* Effect.promise(() => Bun.file(started.scriptPath).text())).toBe(script)
        yield* runtime.wait(started.id)
      }),
    ),
  )

  it.live("rejects an invalid script with the typed validation error", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const failure = yield* runtime
          .start({ sessionID, name: "invalid", script: "return globalThis" })
          .pipe(Effect.flip)
        expect(failure._tag).toBe("WorkflowScript.InvalidScriptError")
        if (failure._tag === "WorkflowScript.InvalidScriptError") expect(failure.reason).toContain("globalThis")
        expect(yield* runtime.list()).toEqual([])
      }),
    ),
  )

  it.live("strips Bun, process, require, fetch and friends from script scope", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({
          sessionID,
          name: "sandbox",
          script: [
            "return [",
            "  typeof Bun,",
            "  typeof process,",
            "  typeof require,",
            "  typeof fetch,",
            "  typeof WebSocket,",
            "  typeof XMLHttpRequest,",
            "  typeof EventSource,",
            "  typeof Worker,",
            "  typeof navigator,",
            "  typeof self,",
            "  typeof postMessage,",
            '].join(",")',
          ].join("\n"),
        })
        const finished = yield* runtime.wait(started.id)
        expect(finished?.status).toBe("completed")
        expect(finished?.result).toBe(Array(11).fill("undefined").join(","))
      }),
    ),
  )

  it.live("blocks the computed .constructor escape that the static guard misses", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        // A function's `.constructor` IS the Function constructor, which rebuilds
        // eval/import. The literal-only validator misses computed access — string
        // concat, array join, variable indirection, template concat — so all of
        // these reach the worker. After the prototype poison `constructor`
        // resolves to undefined, so the call throws before any code is built and
        // node:os is never imported. (Without the poison every one of these
        // completes, executing arbitrary Function-constructor code.)
        const escapes = {
          concat: 'const f = function () {}\nreturn f["cons" + "tructor"]("return import(\\"node:os\\")")()',
          arrayJoin: 'const f = function () {}\nreturn f[["cons", "tructor"].join("")]("return import(\\"node:os\\")")()',
          variable: 'const f = function () {}\nconst k = "constructor"\nreturn f[k]("return typeof process")()',
          template: 'const part = "tructor"\nconst f = async () => {}\nreturn f[`cons${part}`]("return typeof process")()',
        }
        for (const [name, script] of Object.entries(escapes)) {
          const started = yield* runtime.start({ sessionID, name: `escape-${name}`, script })
          const finished = yield* runtime.wait(started.id)
          // The escape must not reach the module/global: either the run fails
          // (poison made `constructor` non-callable), or the result is a benign
          // scalar — never a module object or a leaked global.
          if (finished?.status === "completed") {
            expect(finished.result).not.toContain("Module")
            expect(finished.result).not.toContain("[object")
          } else {
            expect(finished?.status).toBe("failed")
            expect(finished?.error).toContain("not a function")
          }
        }
      }),
    ),
  )

  it.live("still constructs a legitimate script body after the constructor poison", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({ sessionID, name: "legit", script: "return 42" })
        const finished = yield* runtime.wait(started.id)
        expect(finished?.status).toBe("completed")
        expect(finished?.result).toBe("42")
      }),
    ),
  )

  it.live("bounds concurrent agent executions to the configured cap", () =>
    Effect.gen(function* () {
      const observed = { active: 0, max: 0 }
      const executor: WorkflowExecutor.Interface["execute"] = (request) =>
        Effect.gen(function* () {
          observed.active++
          observed.max = Math.max(observed.max, observed.active)
          yield* sleep(25)
          observed.active--
          return { text: request.prompt, tokens: { input: 0, output: 0, reasoning: 0 } }
        })
      yield* harness(executor, () =>
        Effect.gen(function* () {
          const runtime = yield* WorkflowRuntime.Service
          const started = yield* runtime.start({
            sessionID,
            name: "bounded",
            script: [
              "const results = await map([1, 2, 3, 4, 5, 6, 7, 8], (item) =>",
              '  agent({ prompt: "item " + item }), { concurrency: 8 })',
              "return String(results.length)",
            ].join("\n"),
            concurrency: 2,
          })
          const finished = yield* runtime.wait(started.id)
          expect(finished?.status).toBe("completed")
          expect(finished?.result).toBe("8")
        }),
      )
      expect(observed.max).toBe(2)
    }),
  )

  it.live("enforces the per-run agent cap with a useful error", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({
          sessionID,
          name: "capped",
          script: 'return map([1, 2, 3, 4, 5], (item) => agent({ prompt: "item " + item }))',
          maxAgents: 3,
        })
        const finished = yield* runtime.wait(started.id)
        expect(finished?.status).toBe("failed")
        expect(finished?.error).toContain("Workflow agent limit reached (3 agents per run)")
        expect(finished?.agents.length).toBe(3)
      }),
    ),
  )

  it.live("propagates executor failures into the script with a readable message", () =>
    Effect.gen(function* () {
      const failing: WorkflowExecutor.Interface["execute"] = (request) =>
        Effect.fail(new WorkflowExecutor.ExecutionError({ message: `boom: ${request.prompt}` }))
      yield* harness(failing, () =>
        Effect.gen(function* () {
          const runtime = yield* WorkflowRuntime.Service
          const uncaught = yield* runtime.start({
            sessionID,
            name: "uncaught",
            script: 'return (await agent({ prompt: "explode" })).text',
          })
          const failed = yield* runtime.wait(uncaught.id)
          expect(failed?.status).toBe("failed")
          expect(failed?.error).toBe("boom: explode")
          expect(failed?.agents).toMatchObject([{ status: "failed", error: "boom: explode" }])

          // The script can observe the same message and recover.
          const caught = yield* runtime.start({
            sessionID,
            name: "caught",
            script: [
              "try {",
              '  await agent({ prompt: "explode" })',
              "} catch (error) {",
              '  return "caught " + error.message',
              "}",
            ].join("\n"),
          })
          const recovered = yield* runtime.wait(caught.id)
          expect(recovered?.status).toBe("completed")
          expect(recovered?.result).toBe("caught boom: explode")
        }),
      )
    }),
  )

  it.live("stop cancels a run and settles inflight agents as stopped", () =>
    harness(
      () => Effect.never,
      () =>
        Effect.gen(function* () {
          const runtime = yield* WorkflowRuntime.Service
          const started = yield* runtime.start({
            sessionID,
            name: "stoppable",
            script: 'return (await agent({ prompt: "hang" })).text',
          })
          yield* waitUntil(runtime.get(started.id).pipe(Effect.map((run) => run?.agents.at(0)?.status === "running")))
          expect(yield* runtime.stop(started.id)).toBe(true)
          const finished = yield* runtime.wait(started.id)
          expect(finished?.status).toBe("stopped")
          expect(finished?.agents).toMatchObject([{ status: "stopped" }])
          // Stopping a settled run reports false.
          expect(yield* runtime.stop(started.id)).toBe(false)
        }),
    ),
  )

  it.live("stop(runID, agentID) rejects one agent and settles it as stopped while the run continues", () =>
    Effect.gen(function* () {
      const executor: WorkflowExecutor.Interface["execute"] = (request) =>
        request.prompt === "hang"
          ? Effect.never
          : Effect.succeed({ text: `${request.prompt}:ok`, tokens: { input: 1, output: 1, reasoning: 0 } })
      yield* harness(executor, () =>
        Effect.gen(function* () {
          const runtime = yield* WorkflowRuntime.Service
          const started = yield* runtime.start({
            sessionID,
            name: "stop-one",
            script: [
              "let stopped = false",
              "try {",
              '  await agent({ prompt: "hang" })',
              "} catch {",
              "  stopped = true",
              "}",
              'const ok = await agent({ prompt: "go" })',
              'return stopped + " " + ok.text',
            ].join("\n"),
          })
          yield* waitUntil(runtime.get(started.id).pipe(Effect.map((run) => run?.agents.at(0)?.status === "running")))
          const target = (yield* runtime.get(started.id))?.agents.at(0)?.id
          expect(target).toBeDefined()
          // Stopping the hanging agent rejects its agent() promise; the script
          // catches it and the run continues to completion.
          expect(yield* runtime.stop(started.id, target ?? "")).toBe(true)
          const finished = yield* runtime.wait(started.id)
          expect(finished?.status).toBe("completed")
          expect(finished?.result).toBe("true go:ok")
          expect(finished?.agents.find((agent) => agent.id === target)?.status).toBe("stopped")
          // Stopping an agent that is no longer inflight reports false.
          expect(yield* runtime.stop(started.id, target ?? "")).toBe(false)
        }),
      )
    }),
  )

  it.live("pause halts spawning and resume replays completed agents from the cache", () =>
    Effect.gen(function* () {
      const calls = new Map<string, number>()
      const gate = { block: true }
      const executor: WorkflowExecutor.Interface["execute"] = (request) =>
        Effect.suspend(() => {
          calls.set(request.prompt, (calls.get(request.prompt) ?? 0) + 1)
          if (request.prompt.startsWith("second") && gate.block) return Effect.never
          return Effect.succeed({ text: `${request.prompt}:ok`, tokens: { input: 1, output: 1, reasoning: 0 } })
        })
      yield* harness(executor, () =>
        Effect.gen(function* () {
          const runtime = yield* WorkflowRuntime.Service
          const started = yield* runtime.start({
            sessionID,
            name: "pausable",
            script: [
              'const first = await phase("one", () => agent({ prompt: "first" }))',
              'const second = await phase("two", () => agent({ prompt: "second " + first.text }))',
              "return second.text",
            ].join("\n"),
          })
          yield* waitUntil(
            runtime
              .get(started.id)
              .pipe(Effect.map((run) => run?.agents.some((agent) => agent.phase === "two") === true)),
          )
          expect(yield* runtime.pause(started.id)).toBe(true)
          expect((yield* runtime.get(started.id))?.status).toBe("paused")
          expect(calls.get("first")).toBe(1)

          gate.block = false
          expect(yield* runtime.resume(started.id)).toBe(true)
          const finished = yield* runtime.wait(started.id)
          expect(finished?.status).toBe("completed")
          expect(finished?.result).toBe("second first:ok:ok")
          // The cached first-phase result resolved instantly; only the
          // interrupted second-phase agent executed again.
          expect(calls.get("first")).toBe(1)
          expect(calls.get("second first:ok")).toBe(2)
        }),
      )
    }),
  )

  it.live("publishes durable started/finished events with token totals", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const events = yield* Event.Service
        const started = yield* runtime.start({
          sessionID,
          name: "audited",
          script: 'return (await agent({ prompt: "hello" })).text',
        })
        yield* runtime.wait(started.id)
        const recorded = yield* events.aggregateEvents({ aggregateID: sessionID }).pipe(
          Stream.takeUntil((event) => event.event.type === "session.workflow.finished"),
          Stream.runCollect,
        )
        const types = recorded.map((event) => event.event.type)
        expect(types).toContain("session.workflow.started")
        expect(types).toContain("session.workflow.finished")
        const finished = recorded.findLast((event) => event.event.type === "session.workflow.finished")
        expect(finished?.event.data).toMatchObject({
          sessionID,
          runID: started.id,
          name: "audited",
          scriptPath: started.scriptPath,
          status: "completed",
          tokens: { input: 1, output: 2, reasoning: 0 },
        })
      }),
    ),
  )

  it.live("publishes coalesced ephemeral run snapshots ending in the terminal state", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const events = yield* Event.Service
        const snapshots = yield* events.subscribe(WorkflowEvent.Updated).pipe(
          Stream.takeUntil((event) => event.data.run.status !== "running" && event.data.run.status !== "paused"),
          Stream.runCollect,
          Effect.forkChild,
        )
        // The PubSub subscription must be live before the run starts.
        yield* sleep(30)
        const started = yield* runtime.start({
          sessionID,
          name: "observed",
          script: 'return (await phase("only", () => agent({ prompt: "hello" }))).text',
        })
        yield* runtime.wait(started.id)
        const collected = yield* Fiber.join(snapshots)
        expect(collected.length).toBeGreaterThanOrEqual(1)
        const last = collected.at(-1)?.data.run
        expect(last?.status).toBe("completed")
        expect(last?.phases).toMatchObject([{ name: "only", status: "completed", agents: 1 }])
        expect(last?.result).toBe("hello:ok")
      }),
    ),
  )

  it.live("lists runs per session, newest first", () =>
    harness(echo, () =>
      Effect.gen(function* () {
        const runtime = yield* WorkflowRuntime.Service
        const other = SessionSchema.ID.make("ses_workflow_runtime_other")
        const first = yield* runtime.start({ sessionID, name: "first", script: "return 1" })
        yield* runtime.wait(first.id)
        const second = yield* runtime.start({ sessionID, name: "second", script: "return 2" })
        yield* runtime.wait(second.id)
        expect((yield* runtime.list(sessionID)).map((run) => run.name)).toEqual(["second", "first"])
        expect(yield* runtime.list(other)).toEqual([])
        expect((yield* runtime.get(first.id))?.result).toBe("1")
        expect(yield* runtime.get(WorkflowSchema.RunID.make("wfr_missing"))).toBeUndefined()
      }),
    ),
  )
})
