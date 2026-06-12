// Workflow runtime service: registry of live runs for the instance, script
// persistence, BackgroundJob integration (background execution + completion
// notification) and EventV2 publishing for the TUI/server API.
import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode-ai/core/global"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import * as Log from "@opencode-ai/core/util/log"
import type { SessionID } from "@/session/schema"
import { WorkflowRun, type AgentExecutor, type RunSnapshot, type WorkflowEvent } from "./run"
import { WorkflowSchema } from "./schema"
import { WorkflowScript } from "./script"

const log = Log.create({ service: "workflow.runtime" })

export const JOB_TYPE = "workflow"

export type StartInput = {
  name: string
  script: string
  args?: unknown
  parentSessionID?: SessionID
  executor: AgentExecutor
  /** Test hooks; production callers use the defaults. */
  maxConcurrent?: number
  maxAgents?: number
}

export type StartResult = {
  id: string
  scriptPath: string
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<StartResult, Error>
  readonly list: () => Effect.Effect<RunSnapshot[]>
  readonly get: (id: string) => Effect.Effect<RunSnapshot | undefined>
  readonly pause: (id: string) => Effect.Effect<boolean>
  readonly resume: (id: string) => Effect.Effect<boolean>
  readonly cancel: (id: string) => Effect.Effect<boolean>
  readonly stopAgent: (id: string, agentID: string) => Effect.Effect<boolean>
  readonly restartAgent: (id: string, agentID: string) => Effect.Effect<boolean>
  readonly wait: (id: string) => Effect.Effect<BackgroundJob.WaitResult>
  readonly saveAs: (
    id: string,
    options: { name: string; global?: boolean },
  ) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkflowRuntime") {}

type State = {
  runs: Map<string, WorkflowRun>
}

function runID(): string {
  return `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export const layer: Layer.Layer<Service, never, BackgroundJob.Service | EventV2Bridge.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(() => Effect.succeed({ runs: new Map<string, WorkflowRun>() }))

    const publish = (event: WorkflowEvent): Effect.Effect<void> => {
      switch (event.type) {
        case "run.started":
          return events.publish(WorkflowSchema.Event.RunStarted, {
            runID: event.run.id,
            name: event.run.name,
            sessionID: event.run.parentSessionID,
            scriptPath: event.run.scriptPath,
          })
        case "run.updated":
          return events.publish(WorkflowSchema.Event.RunUpdated, { runID: event.runID, status: event.status })
        case "run.finished":
          return events.publish(WorkflowSchema.Event.RunFinished, {
            runID: event.runID,
            status: event.status,
            error: event.error,
          })
        case "phase.started":
          return events.publish(WorkflowSchema.Event.PhaseStarted, { runID: event.runID, name: event.name })
        case "phase.finished":
          return events.publish(WorkflowSchema.Event.PhaseFinished, { runID: event.runID, name: event.name })
        case "agent.started":
          return events.publish(WorkflowSchema.Event.AgentStarted, {
            runID: event.runID,
            agentID: event.agent.id,
            phase: event.agent.phase,
          })
        case "agent.finished":
          return events.publish(WorkflowSchema.Event.AgentFinished, {
            runID: event.runID,
            agentID: event.agent.id,
            phase: event.agent.phase,
            status: event.agent.status,
            tokens: event.agent.tokens,
          })
        case "log":
          return events.publish(WorkflowSchema.Event.Log, { runID: event.runID, message: event.message })
      }
    }

    const start: Interface["start"] = Effect.fn("WorkflowRuntime.start")(function* (input: StartInput) {
      const validation = WorkflowScript.validate(input.script)
      if (!validation.ok) return yield* Effect.fail(new Error(validation.error))

      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const bridge = yield* EffectBridge.make()
      const id = runID()

      // Persist the script so the user can read, diff, edit, and relaunch it.
      const dir = path.join(Global.Path.data, "workflow", ctx.project.id)
      const scriptPath = path.join(dir, `${id}.mjs`)
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(scriptPath, input.script, "utf8")
        },
        catch: (error) => new Error(`Failed to persist workflow script: ${error}`),
      })

      const run = new WorkflowRun({
        id,
        name: input.name,
        script: input.script,
        args: input.args,
        scriptPath,
        parentSessionID: input.parentSessionID,
        executor: input.executor,
        maxConcurrent: input.maxConcurrent,
        maxAgents: input.maxAgents,
        emit: (event) => {
          void bridge.promise(publish(event)).catch((error) => {
            log.warn("workflow event publish failed", { error: String(error) })
          })
        },
      })
      s.runs.set(id, run)

      const runEffect = Effect.promise(() => run.done).pipe(
        Effect.flatMap((result) =>
          result.status === "completed"
            ? Effect.succeed(result.result ?? "")
            : Effect.fail(new Error(result.error ?? `Workflow ${result.status}`)),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            run.cancel()
          }),
        ),
      )

      yield* background.start({
        id,
        type: JOB_TYPE,
        title: input.name,
        metadata: {
          workflow: true,
          background: true,
          ...(input.parentSessionID ? { parentSessionId: input.parentSessionID } : {}),
          scriptPath,
        },
        run: runEffect,
      })

      run.start()
      return { id, scriptPath }
    })

    const find = Effect.fnUntraced(function* (id: string) {
      const s = yield* InstanceState.get(state)
      return s.runs.get(id)
    })

    const list: Interface["list"] = Effect.fn("WorkflowRuntime.list")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.runs.values()].map((run) => run.snapshot()).toSorted((a, b) => b.startedAt - a.startedAt)
    })

    const get: Interface["get"] = Effect.fn("WorkflowRuntime.get")(function* (id: string) {
      return (yield* find(id))?.snapshot()
    })

    const pause: Interface["pause"] = Effect.fn("WorkflowRuntime.pause")(function* (id: string) {
      return (yield* find(id))?.pause() ?? false
    })

    const resume: Interface["resume"] = Effect.fn("WorkflowRuntime.resume")(function* (id: string) {
      return (yield* find(id))?.resume() ?? false
    })

    const cancel: Interface["cancel"] = Effect.fn("WorkflowRuntime.cancel")(function* (id: string) {
      const run = yield* find(id)
      if (!run) return false
      const cancelled = run.cancel()
      yield* background.cancel(id)
      return cancelled
    })

    const stopAgent: Interface["stopAgent"] = Effect.fn("WorkflowRuntime.stopAgent")(function* (
      id: string,
      agentID: string,
    ) {
      return (yield* find(id))?.stopAgent(agentID) ?? false
    })

    const restartAgent: Interface["restartAgent"] = Effect.fn("WorkflowRuntime.restartAgent")(function* (
      id: string,
      agentID: string,
    ) {
      return (yield* find(id))?.restartAgent(agentID) ?? false
    })

    const wait: Interface["wait"] = Effect.fn("WorkflowRuntime.wait")(function* (id: string) {
      return yield* background.wait({ id })
    })

    const saveAs: Interface["saveAs"] = Effect.fn("WorkflowRuntime.saveAs")(function* (
      id: string,
      options: { name: string; global?: boolean },
    ) {
      const run = yield* find(id)
      if (!run) return yield* Effect.fail(new Error(`Unknown workflow run: ${id}`))
      if (!WorkflowScript.validName(options.name))
        return yield* Effect.fail(new Error(`Invalid workflow name: ${options.name}`))
      const ctx = yield* InstanceState.context
      const dir = options.global
        ? path.join(Global.Path.config, "workflows")
        : path.join(ctx.worktree, ".opencode", "workflows")
      const file = path.join(dir, `${options.name}.mjs`)
      const content = WorkflowScript.withFrontmatter({ name: options.name, body: run.script })
      yield* Effect.tryPromise({
        try: async () => {
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(file, content, "utf8")
        },
        catch: (error) => new Error(`Failed to save workflow: ${error}`),
      })
      return file
    })

    return Service.of({ start, list, get, pause, resume, cancel, stopAgent, restartAgent, wait, saveAs })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export * as WorkflowRuntime from "./runtime"
