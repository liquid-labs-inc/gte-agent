export * as WorkflowRuntime from "./runtime"

import os from "os"
import path from "path"
import { Cause, Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Semaphore } from "effect"
import { Config } from "../config"
import { Event } from "../event"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { Hash } from "../util/hash"
import { WorkflowEvent } from "./event"
import { WorkflowExecutor } from "./executor"
import { WorkflowProtocol } from "./protocol"
import { WorkflowSchema } from "./schema"
import { WorkflowScript } from "./script"

/**
 * Workflow runtime: a process-local registry of live runs. Each run executes
 * its orchestration script in a sandboxed Bun Worker, schedules the agents the
 * script requests through the injected executor under a concurrency cap, and
 * is observable three ways: durable started/finished session events, the
 * ephemeral coalesced `session.workflow.updated` snapshot, and the persisted
 * script on disk. Like BackgroundJob, restart loses live runs by design — the
 * script file is the recovery artifact.
 */

export const JOB_TYPE = "workflow"
export const MAX_AGENTS_PER_RUN = 1_000
export const DEFAULT_SNAPSHOT_TICK_MS = 200
const MAX_LOG_LINES = 100

/** A run cannot start when its script fails to persist to the agent data dir. */
export class ScriptPersistError extends Schema.TaggedErrorClass<ScriptPersistError>()("WorkflowRuntime.ScriptPersistError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** Concurrent-agent cap: min(16, max(2, cores - 2)). */
export function concurrencyCap(cores: number = os.cpus().length || 4) {
  return Math.min(16, Math.max(2, cores - 2))
}

/**
 * Kill switch: a truthy GTE_AGENT_DISABLE_WORKFLOWS or `workflows.enabled:
 * false` in config hides the workflow tool and every surface built on it.
 */
export const enabled = Effect.gen(function* () {
  if (Flag.GTE_AGENT_DISABLE_WORKFLOWS) return false
  const entries = yield* (yield* Config.Service).entries()
  const merged: Config.Info = Object.assign(
    {},
    ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
  )
  return merged.workflows?.enabled !== false
})

/** Pause/resume and dedupe cache key: results are content-addressed by (phase, hash of prompt + type + model + variant). */
export function cacheKey(phase: string, request: WorkflowProtocol.AgentRequest) {
  return (
    phase +
    " " +
    Hash.sha256(JSON.stringify([request.prompt, request.type ?? "", request.model ?? "", request.variant ?? ""]))
  )
}

/** The script's resolved return value, rendered for the tool result and transcript. */
export function renderResult(value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

export type StartInput = {
  sessionID: SessionSchema.ID
  name: string
  script: string
  args?: unknown
  /** Test seams; production callers use the defaults. */
  concurrency?: number
  maxAgents?: number
}

export interface Interface {
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<WorkflowSchema.RunInfo, WorkflowScript.InvalidScriptError | ScriptPersistError>
  /** Resolves with the final snapshot once the run reaches a terminal status. */
  readonly wait: (runID: WorkflowSchema.RunID) => Effect.Effect<WorkflowSchema.RunInfo | undefined>
  readonly list: (sessionID?: SessionSchema.ID) => Effect.Effect<WorkflowSchema.RunInfo[]>
  readonly get: (runID: WorkflowSchema.RunID) => Effect.Effect<WorkflowSchema.RunInfo | undefined>
  readonly pause: (runID: WorkflowSchema.RunID) => Effect.Effect<boolean>
  readonly resume: (runID: WorkflowSchema.RunID) => Effect.Effect<boolean>
  /** Stops the whole run, or one inflight agent when agentID is given. */
  readonly stop: (runID: WorkflowSchema.RunID, agentID?: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/WorkflowRuntime") {}

export type Options = {
  /** Minimum interval between ephemeral run-snapshot events per run. Default 200ms. */
  readonly snapshotTickMs?: number
}

type AgentState = {
  readonly id: string
  readonly phase: string
  readonly prompt: string
  model?: string
  variant?: string
  requestedModel?: string
  requestedVariant?: string
  sessionID?: SessionSchema.ID
  status: WorkflowSchema.AgentStatus
  tokens: { input: number; output: number; reasoning: number }
  error?: string
  readonly started: number
  finished?: number
}

type PhaseState = {
  status: WorkflowSchema.PhaseStatus
  readonly started: number
  finished?: number
}

type Run = {
  readonly id: WorkflowSchema.RunID
  readonly sessionID: SessionSchema.ID
  readonly name: string
  readonly script: string
  readonly args: unknown
  readonly scriptPath: string
  readonly maxAgents: number
  readonly gate: Semaphore.Semaphore
  readonly started: number
  readonly agents: AgentState[]
  readonly phases: Map<string, PhaseState>
  readonly cache: Map<string, WorkflowProtocol.AgentResult>
  readonly inflight: Map<string, { state: AgentState; fiber: Fiber.Fiber<void>; workerCallID: number }>
  readonly logs: { time: number; message: string }[]
  readonly done: Deferred.Deferred<void>
  status: WorkflowSchema.RunStatus
  finished?: number
  result?: string
  error?: string
  worker?: Worker
  /** Bumped on every worker teardown so stale worker and agent callbacks drop. */
  generation: number
  launched: number
  agentSeq: number
  // Trailing-edge snapshot throttle state.
  lastEmit: number
  pending: boolean
  timer?: ReturnType<typeof setTimeout>
}

const tokensOf = (agents: readonly AgentState[]) =>
  agents.reduce(
    (total, agent) => ({
      input: total.input + agent.tokens.input,
      output: total.output + agent.tokens.output,
      reasoning: total.reasoning + agent.tokens.reasoning,
    }),
    { input: 0, output: 0, reasoning: 0 },
  )

const terminal = (status: WorkflowSchema.RunStatus): status is WorkflowSchema.TerminalStatus =>
  status === "completed" || status === "failed" || status === "stopped"

const head = (prompt: string) => prompt.replace(/\s+/g, " ").trim().slice(0, WorkflowSchema.MAX_PROMPT_HEAD)

export const layerWith = (
  options?: Options,
): Layer.Layer<Service, never, Event.Service | Global.Service | WorkflowExecutor.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const tick = options?.snapshotTickMs ?? DEFAULT_SNAPSHOT_TICK_MS
      const events = yield* Event.Service
      const global = yield* Global.Service
      const executor = yield* WorkflowExecutor.Service
      const context = yield* Effect.context()
      const fork = Effect.runForkWith(context)
      const runs = new Map<WorkflowSchema.RunID, Run>()
      // Set during finalization so teardown never publishes into a closing runtime.
      let closed = false
      const runFork = <A, E>(effect: Effect.Effect<A, E>) => {
        if (!closed) fork(effect)
      }

      const snapshot = (run: Run) =>
        WorkflowSchema.RunInfo.make({
          id: run.id,
          sessionID: run.sessionID,
          name: run.name,
          status: run.status,
          scriptPath: run.scriptPath,
          tokens: tokensOf(run.agents),
          agentTotal: run.launched,
          time: {
            started: DateTime.makeUnsafe(run.started),
            ...(run.finished === undefined ? {} : { finished: DateTime.makeUnsafe(run.finished) }),
          },
          phases: [...run.phases].map(([name, phase]) => {
            const members = run.agents.filter((agent) => agent.phase === name)
            return {
              name,
              status: phase.status,
              agents: members.length,
              tokens: tokensOf(members),
              time: {
                started: DateTime.makeUnsafe(phase.started),
                ...(phase.finished === undefined ? {} : { finished: DateTime.makeUnsafe(phase.finished) }),
              },
            }
          }),
          agents: run.agents.map((agent) => ({
            id: agent.id,
            phase: agent.phase,
            prompt: agent.prompt,
            ...(agent.model === undefined ? {} : { model: agent.model }),
            ...(agent.variant === undefined ? {} : { variant: agent.variant }),
            ...(agent.requestedModel === undefined ? {} : { requestedModel: agent.requestedModel }),
            ...(agent.requestedVariant === undefined ? {} : { requestedVariant: agent.requestedVariant }),
            ...(agent.sessionID === undefined ? {} : { sessionID: agent.sessionID }),
            status: agent.status,
            tokens: { ...agent.tokens },
            ...(agent.error === undefined ? {} : { error: agent.error }),
            time: {
              started: DateTime.makeUnsafe(agent.started),
              ...(agent.finished === undefined ? {} : { finished: DateTime.makeUnsafe(agent.finished) }),
            },
          })),
          logs: run.logs.map((line) => ({ time: DateTime.makeUnsafe(line.time), message: line.message })),
          ...(run.result === undefined ? {} : { result: run.result }),
          ...(run.error === undefined ? {} : { error: run.error }),
        })

      const publishSnapshot = (run: Run) =>
        events.publish(WorkflowEvent.Updated, { sessionID: run.sessionID, run: snapshot(run) }).pipe(Effect.asVoid)

      /** Coalescing tick: immediate leading emit, one trailing emit for bursts (panel-event precedent). */
      const emitSnapshot = (run: Run) => {
        const now = Date.now()
        if (now - run.lastEmit >= tick && run.timer === undefined) {
          run.lastEmit = now
          runFork(publishSnapshot(run))
          return
        }
        run.pending = true
        if (run.timer !== undefined) return
        run.timer = setTimeout(
          () => {
            run.timer = undefined
            if (!run.pending) return
            run.pending = false
            run.lastEmit = Date.now()
            runFork(publishSnapshot(run))
          },
          Math.max(0, run.lastEmit + tick - now),
        )
      }

      /** Terminal and control transitions publish immediately so consumers never wait out the tick. */
      const flushSnapshot = (run: Run) => {
        if (run.timer !== undefined) clearTimeout(run.timer)
        run.timer = undefined
        run.pending = false
        run.lastEmit = Date.now()
        runFork(publishSnapshot(run))
      }

      const post = (worker: Worker, message: WorkflowProtocol.HostToWorker) => {
        try {
          worker.postMessage(message)
        } catch {
          // the worker terminated between the state check and the call
        }
      }

      const log = (run: Run, message: string) => {
        run.logs.push({ time: Date.now(), message })
        if (run.logs.length > MAX_LOG_LINES) run.logs.splice(0, run.logs.length - MAX_LOG_LINES)
      }

      const teardownWorker = (run: Run) => {
        run.generation++
        run.worker?.terminate()
        run.worker = undefined
        // Map iteration tolerates deletes of the current entry.
        for (const [agentID, entry] of run.inflight) {
          run.inflight.delete(agentID)
          entry.state.status = "stopped"
          entry.state.finished = Date.now()
          fork(Fiber.interrupt(entry.fiber))
        }
      }

      const finish = (
        run: Run,
        status: WorkflowSchema.TerminalStatus,
        outcome: { result?: string; error?: string },
      ) => {
        if (terminal(run.status)) return
        teardownWorker(run)
        run.status = status
        run.finished = Date.now()
        run.result = outcome.result
        run.error = outcome.error
        for (const phase of run.phases.values()) {
          if (phase.status === "running") {
            phase.status = "completed"
            phase.finished = run.finished
          }
        }
        flushSnapshot(run)
        // The durable Finished event must be written before run.done resolves,
        // so the tool's synchronous settlement and wait() never return before
        // the audit boundary is in the log. During shutdown the runtime no
        // longer publishes, so resolve waiters directly instead of stranding
        // them on a fork that never runs.
        if (closed) {
          Deferred.doneUnsafe(run.done, Exit.void)
          return
        }
        fork(
          events
            .publish(SessionEvent.Workflow.Finished, {
              sessionID: run.sessionID,
              timestamp: DateTime.makeUnsafe(run.finished),
              runID: run.id,
              name: run.name,
              scriptPath: run.scriptPath,
              status,
              tokens: tokensOf(run.agents),
              duration: run.finished - run.started,
            })
            .pipe(Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(run.done, Exit.void)))),
        )
      }

      const settle = (
        run: Run,
        generation: number,
        state: AgentState,
        key: string,
        workerCallID: number,
        outcome: { result?: WorkflowExecutor.Result; error?: string },
      ) => {
        run.inflight.delete(state.id)
        state.finished = Date.now()
        if (run.status !== "running" || generation !== run.generation) {
          state.status = "stopped"
          return
        }
        if (outcome.result) {
          state.status = "completed"
          state.tokens = { ...outcome.result.tokens }
          if (outcome.result.model !== undefined) state.model = outcome.result.model
          if (outcome.result.variant !== undefined) state.variant = outcome.result.variant
          if (outcome.result.requestedModel !== undefined) state.requestedModel = outcome.result.requestedModel
          if (outcome.result.requestedVariant !== undefined) state.requestedVariant = outcome.result.requestedVariant
          if (outcome.result.sessionID !== undefined) state.sessionID = outcome.result.sessionID
          if (outcome.result.fallback !== undefined) log(run, `${state.id}: ${outcome.result.fallback}`)
          const value = { text: outcome.result.text, tokens: { ...outcome.result.tokens } }
          run.cache.set(key, value)
          if (run.worker) post(run.worker, { type: "agent-result", id: workerCallID, ok: true, value })
        }
        if (!outcome.result) {
          state.status = "failed"
          state.error = outcome.error ?? "Workflow agent failed"
          if (run.worker) post(run.worker, { type: "agent-result", id: workerCallID, ok: false, error: state.error })
        }
        emitSnapshot(run)
      }

      const onAgentRequest = (
        run: Run,
        worker: Worker,
        generation: number,
        message: Extract<WorkflowProtocol.WorkerToHost, { type: "agent" }>,
      ) => {
        const key = cacheKey(message.phase, message.request)
        const cached = run.cache.get(key)
        if (cached) {
          post(worker, { type: "agent-result", id: message.id, ok: true, value: cached })
          return
        }
        if (run.launched >= run.maxAgents) {
          post(worker, {
            type: "agent-result",
            id: message.id,
            ok: false,
            error: `Workflow agent limit reached (${run.maxAgents} agents per run)`,
          })
          return
        }
        run.launched++
        const state: AgentState = {
          id: `a${++run.agentSeq}`,
          phase: message.phase,
          prompt: head(message.request.prompt),
          ...(message.request.model === undefined ? {} : { model: message.request.model }),
          ...(message.request.variant === undefined ? {} : { variant: message.request.variant }),
          status: "queued",
          tokens: { input: 0, output: 0, reasoning: 0 },
          started: Date.now(),
        }
        run.agents.push(state)
        const fiber = fork(
          run.gate
            .withPermit(
              Effect.suspend(() => {
                state.status = "running"
                emitSnapshot(run)
                return executor.execute({
                  sessionID: run.sessionID,
                  runID: run.id,
                  agentID: state.id,
                  phase: message.phase,
                  prompt: message.request.prompt,
                  ...(message.request.type === undefined ? {} : { type: message.request.type }),
                  ...(message.request.model === undefined ? {} : { model: message.request.model }),
                  ...(message.request.variant === undefined ? {} : { variant: message.request.variant }),
                })
              }),
            )
            .pipe(
              Effect.matchCauseEffect({
                onSuccess: (result) => Effect.sync(() => settle(run, generation, state, key, message.id, { result })),
                onFailure: (cause) =>
                  Effect.sync(() =>
                    settle(run, generation, state, key, message.id, {
                      error: WorkflowExecutor.describeFailure(Cause.squash(cause)),
                    }),
                  ),
              }),
            ),
        )
        // A synchronous executor settles inside fork() before this line runs;
        // only agents that are still pending belong in the inflight set.
        if (state.status === "queued" || state.status === "running")
          run.inflight.set(state.id, { state, fiber, workerCallID: message.id })
        emitSnapshot(run)
      }

      const onWorkerMessage = (
        run: Run,
        worker: Worker,
        generation: number,
        message: WorkflowProtocol.WorkerToHost,
      ) => {
        switch (message.type) {
          case "ready":
            post(worker, { type: "start", script: run.script, args: run.args })
            return
          case "phase-started": {
            const phase = run.phases.get(message.name)
            // Resume re-executes the script, so a known phase re-enters "running"
            // and keeps its original start time.
            if (phase) {
              phase.status = "running"
              phase.finished = undefined
            }
            if (!phase) run.phases.set(message.name, { status: "running", started: Date.now() })
            emitSnapshot(run)
            return
          }
          case "phase-ended": {
            const phase = run.phases.get(message.name)
            if (phase) {
              phase.status = "completed"
              phase.finished = Date.now()
            }
            emitSnapshot(run)
            return
          }
          case "log":
            log(run, message.message)
            emitSnapshot(run)
            return
          case "agent":
            onAgentRequest(run, worker, generation, message)
            return
          case "done":
            finish(run, "completed", { result: renderResult(message.result) })
            return
          case "failed":
            finish(run, "failed", { error: message.reason || "Workflow script failed" })
            return
        }
      }

      const spawn = (run: Run) => {
        const generation = ++run.generation
        const worker = new Worker(new URL("./worker.ts", import.meta.url))
        run.worker = worker
        worker.onmessage = (event: MessageEvent<WorkflowProtocol.WorkerToHost>) => {
          if (generation !== run.generation || terminal(run.status)) return
          onWorkerMessage(run, worker, generation, event.data)
        }
        worker.onerror = (event: ErrorEvent) => {
          if (generation !== run.generation) return
          finish(run, "failed", { error: event.message || "Workflow worker crashed" })
        }
      }

      const start: Interface["start"] = Effect.fn("WorkflowRuntime.start")(function* (input) {
        const invalid = WorkflowScript.validate(input.script)
        if (invalid) return yield* invalid
        const id = WorkflowSchema.RunID.create()
        // Persisted so the user can read, diff, edit, and relaunch the exact
        // script: the registry is process-local, the file survives restarts.
        const scriptPath = path.join(global.data, "workflow-runs", `${id}.mjs`)
        yield* Effect.tryPromise({
          try: () => Bun.write(scriptPath, input.script),
          catch: (error) =>
            new ScriptPersistError({
              path: scriptPath,
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        const run: Run = {
          id,
          sessionID: input.sessionID,
          name: input.name,
          script: input.script,
          args: input.args,
          scriptPath,
          maxAgents: Math.max(1, input.maxAgents ?? MAX_AGENTS_PER_RUN),
          gate: Semaphore.makeUnsafe(Math.max(1, input.concurrency ?? concurrencyCap())),
          started: Date.now(),
          agents: [],
          phases: new Map(),
          cache: new Map(),
          inflight: new Map(),
          logs: [],
          done: Deferred.makeUnsafe<void>(),
          status: "running",
          generation: 0,
          launched: 0,
          agentSeq: 0,
          lastEmit: 0,
          pending: false,
        }
        runs.set(id, run)
        yield* events.publish(SessionEvent.Workflow.Started, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(run.started),
          runID: id,
          name: input.name,
          scriptPath,
        })
        spawn(run)
        emitSnapshot(run)
        return snapshot(run)
      })

      const wait: Interface["wait"] = Effect.fn("WorkflowRuntime.wait")(function* (runID) {
        const run = runs.get(runID)
        if (!run) return undefined
        yield* Deferred.await(run.done)
        return snapshot(run)
      })

      const list: Interface["list"] = Effect.fn("WorkflowRuntime.list")(function* (sessionID) {
        return [...runs.values()]
          .filter((run) => sessionID === undefined || run.sessionID === sessionID)
          .toSorted((a, b) => b.started - a.started)
          .map(snapshot)
      })

      const get: Interface["get"] = Effect.fn("WorkflowRuntime.get")(function* (runID) {
        const run = runs.get(runID)
        return run === undefined ? undefined : snapshot(run)
      })

      const pause: Interface["pause"] = Effect.fn("WorkflowRuntime.pause")(function* (runID) {
        const run = runs.get(runID)
        if (!run || run.status !== "running") return false
        run.status = "paused"
        teardownWorker(run)
        flushSnapshot(run)
        return true
      })

      const resume: Interface["resume"] = Effect.fn("WorkflowRuntime.resume")(function* (runID) {
        const run = runs.get(runID)
        if (!run || run.status !== "paused") return false
        run.status = "running"
        spawn(run)
        flushSnapshot(run)
        return true
      })

      const stop: Interface["stop"] = Effect.fn("WorkflowRuntime.stop")(function* (runID, agentID) {
        const run = runs.get(runID)
        if (!run) return false
        if (agentID !== undefined) {
          const entry = run.inflight.get(agentID)
          if (!entry) return false
          run.inflight.delete(agentID)
          entry.state.status = "stopped"
          entry.state.finished = Date.now()
          entry.state.error = "Agent stopped by user"
          // The script's pending agent() promise must reject or it would hang forever.
          if (run.worker)
            post(run.worker, { type: "agent-result", id: entry.workerCallID, ok: false, error: entry.state.error })
          fork(Fiber.interrupt(entry.fiber))
          flushSnapshot(run)
          return true
        }
        if (terminal(run.status)) return false
        // finish tears the worker down and settles waiters; the run owns its
        // own lifecycle, so a background-job branch (if any) observes the stop
        // through run.done like every other terminal transition.
        finish(run, "stopped", { error: "Workflow stopped" })
        return true
      })

      // Runtime shutdown: tear every live run down and resolve its waiters.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true
          for (const run of runs.values()) {
            if (!terminal(run.status)) finish(run, "stopped", { error: "Workflow runtime shut down" })
            if (run.timer !== undefined) clearTimeout(run.timer)
          }
          runs.clear()
        }),
      )

      return Service.of({ start, wait, list, get, pause, resume, stop })
    }),
  )

export const layer = layerWith()
