import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { ToolCall, ToolResultValue } from "@gte-agent/llm"
import { BackgroundJob } from "@gte-agent/core/background-job"
import { Config } from "@gte-agent/core/config"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { Global } from "@gte-agent/core/global"
import { Permission } from "@gte-agent/core/permission"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { WorkflowTool } from "@gte-agent/core/tool/workflow"
import { WorkflowExecutor } from "@gte-agent/core/workflow/executor"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_workflow_tool")
const childSessionID = SessionSchema.ID.make("ses_workflow_tool_child")

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

const configWith = (info: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info })]) }),
  )

const sessionStore = Layer.mock(SessionStore.Service, {
  get: (id: SessionSchema.ID) =>
    Effect.succeed(
      id === childSessionID
        ? ({ id, parentID: sessionID } as unknown as SessionSchema.Info)
        : ({ id } as unknown as SessionSchema.Info),
    ),
})

const echo: WorkflowExecutor.Interface["execute"] = (request) =>
  Effect.succeed({ text: `${request.prompt}:ok`, tokens: { input: 1, output: 2, reasoning: 0 } })

/**
 * Layers are composed inside each test because the kill-switch flag is read
 * from the environment when the tool layer is built.
 */
const harness = <A, E>(
  body: Effect.Effect<A, E, ToolRegistry.Service | WorkflowRuntime.Service>,
  options?: { config?: Config.Info },
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const database = Database.layerFromPath(":memory:")
    const events = Event.layer.pipe(Layer.provide(database))
    const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
    const runtime = WorkflowRuntime.layerWith({ snapshotTickMs: 20 }).pipe(
      Layer.provide(events),
      Layer.provide(Global.layerWith({ data: tmp.path })),
      Layer.provide(Layer.succeed(WorkflowExecutor.Service, WorkflowExecutor.Service.of({ execute: echo }))),
    )
    const tool = WorkflowTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(runtime),
      Layer.provide(BackgroundJob.layer),
      Layer.provide(sessionStore),
      Layer.provide(configWith(options?.config ?? Config.Info.make({}))),
    )
    return yield* body.pipe(Effect.provide(Layer.mergeAll(registry, runtime, tool)))
  })

const withFlag = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const saved = process.env.GTE_AGENT_DISABLE_WORKFLOWS
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
        else process.env.GTE_AGENT_DISABLE_WORKFLOWS = saved
      }),
    )
    if (value === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
    else process.env.GTE_AGENT_DISABLE_WORKFLOWS = value
    return yield* body
  })

const toolNames = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  return (yield* registry.definitions()).map((definition) => definition.name)
})

const call = (input: Record<string, unknown>): ToolCall => ({
  type: "tool-call",
  id: "call-workflow",
  name: "workflow",
  input,
})

const text = (result: ToolResultValue): string => {
  expect(result.type).toBe("text")
  return String((result as { value: unknown }).value)
}

const errorText = (result: ToolResultValue): string => {
  expect(result.type).toBe("error")
  return String((result as { value: unknown }).value)
}

describe("WorkflowTool registration", () => {
  it.effect("contributes the tool when the flag and config allow it", () =>
    withFlag(undefined, harness(toolNames.pipe(Effect.map((names) => expect(names).toContain("workflow"))))),
  )

  it.effect("GTE_AGENT_DISABLE_WORKFLOWS=1 hides the tool", () =>
    withFlag("1", harness(toolNames.pipe(Effect.map((names) => expect(names).not.toContain("workflow"))))),
  )

  it.effect("workflows.enabled: false in config hides the tool", () =>
    withFlag(
      undefined,
      harness(toolNames.pipe(Effect.map((names) => expect(names).not.toContain("workflow"))), {
        config: Config.Info.make({ workflows: { enabled: false } }),
      }),
    ),
  )

  it.effect("workflows.enabled: true keeps the tool when the flag is unset", () =>
    withFlag(
      undefined,
      harness(toolNames.pipe(Effect.map((names) => expect(names).toContain("workflow"))), {
        config: Config.Info.make({ workflows: { enabled: true } }),
      }),
    ),
  )

  it.effect("the flag wins over an enabling config", () =>
    withFlag(
      "true",
      harness(toolNames.pipe(Effect.map((names) => expect(names).not.toContain("workflow"))), {
        config: Config.Info.make({ workflows: { enabled: true } }),
      }),
    ),
  )
})

describe("WorkflowTool execution", () => {
  it.live("synchronous settlement returns the run result, status, and tokens", () =>
    withFlag(
      undefined,
      harness(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* registry.execute({
            sessionID,
            call: call({
              name: "fan-out",
              script: 'return (await map(args.items, (item) => agent({ prompt: "do " + item }))).length',
              args: { items: ["a", "b"] },
            }),
          })
          const output = text(result)
          expect(output).toContain("2")
          expect(output).toContain("completed")
          expect(output).toContain("Tokens: 2 in / 4 out")
          expect(output).toContain("workflow-runs/wfr_")
        }),
      ),
    ),
  )

  it.live("background: true returns immediately and the run completes through the runtime", () =>
    withFlag(
      undefined,
      harness(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const runtime = yield* WorkflowRuntime.Service
          const result = yield* registry.execute({
            sessionID,
            call: call({
              name: "background-run",
              script: 'return (await agent({ prompt: "work" })).text',
              background: true,
            }),
          })
          expect(text(result)).toContain("running in the background")
          const runs = yield* runtime.list(sessionID)
          expect(runs.length).toBe(1)
          const finished = yield* runtime.wait(runs[0].id)
          expect(finished?.status).toBe("completed")
          expect(finished?.result).toBe("work:ok")
        }),
      ),
    ),
  )

  it.live("a failed run settles the tool call as an error with the run's message", () =>
    withFlag(
      undefined,
      harness(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* registry.execute({
            sessionID,
            call: call({ name: "boom", script: 'throw new Error("scripted failure")' }),
          })
          expect(errorText(result)).toBe("scripted failure")
        }),
      ),
    ),
  )

  it.live("an invalid script settles as an error with the validation reason", () =>
    withFlag(
      undefined,
      harness(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* registry.execute({
            sessionID,
            call: call({ name: "invalid", script: "return globalThis" }),
          })
          expect(errorText(result)).toContain("globalThis")
        }),
      ),
    ),
  )

  it.live("workflow agents cannot start nested workflows", () =>
    withFlag(
      undefined,
      harness(
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const runtime = yield* WorkflowRuntime.Service
          const result = yield* registry.execute({
            sessionID: childSessionID,
            call: call({ name: "nested", script: "return 1" }),
          })
          expect(errorText(result)).toContain("cannot start nested workflows")
          expect(yield* runtime.list()).toEqual([])
        }),
      ),
    ),
  )
})
