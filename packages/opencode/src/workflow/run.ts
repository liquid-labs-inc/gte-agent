// Core workflow run orchestration. Deliberately plain TypeScript (no Effect):
// the runtime service wraps a WorkflowRun in BackgroundJob/EventV2 machinery,
// while tests drive it directly with a stubbed agent executor.
//
// Responsibilities:
// - spawn the sandboxed Bun worker and speak the workflow protocol
// - schedule agent executions with the concurrency cap
// - enforce the total-agent backstop
// - content-address agent results by (phase, prompt-ish hash) so identical
//   requests dedupe and pause/resume replays complete agents instantly
// - pause/resume by terminating and re-running the script against the cache
import os from "os"
import type { AgentRequestOptions, AgentResult, HostToWorker, WorkerToHost } from "./protocol"

declare global {
  const OPENCODE_WORKFLOW_WORKER_PATH: string
}

export type RunStatus = "running" | "paused" | "completed" | "error" | "cancelled"
export type AgentStatus = "queued" | "running" | "completed" | "error" | "cancelled"

export type AgentState = {
  /** Stable run-scoped agent id, e.g. "a12". */
  id: string
  phase: string
  prompt: string
  type?: string
  model?: string
  variant?: string
  status: AgentStatus
  /** Subagent session id, when the executor reports one. */
  sessionID?: string
  startedAt: number
  finishedAt?: number
  tokens: { input: number; output: number }
  result?: string
  error?: string
  attempt: number
}

export type PhaseState = {
  name: string
  status: "running" | "completed"
  startedAt: number
  finishedAt?: number
}

export type LogLine = { time: number; message: string }

export type RunResult = { status: "completed" | "error" | "cancelled"; result?: string; error?: string }

export type RunSnapshot = {
  id: string
  name: string
  parentSessionID?: string
  scriptPath?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  result?: string
  error?: string
  logs: LogLine[]
  phases: (PhaseState & { agentCount: number; tokens: { input: number; output: number } })[]
  agents: AgentState[]
  tokens: { input: number; output: number }
  agentTotal: number
}

export type WorkflowEvent =
  | { type: "run.started"; run: RunSnapshot }
  | { type: "run.updated"; runID: string; status: RunStatus }
  | { type: "run.finished"; runID: string; status: "completed" | "error" | "cancelled"; result?: string; error?: string }
  | { type: "phase.started"; runID: string; name: string }
  | { type: "phase.finished"; runID: string; name: string }
  | { type: "agent.started"; runID: string; agent: AgentState }
  | { type: "agent.finished"; runID: string; agent: AgentState }
  | { type: "log"; runID: string; message: string }

export type AgentExecutionRequest = {
  runID: string
  agentID: string
  phase: string
  attempt: number
  onSession?: (sessionID: string) => void
} & AgentRequestOptions

export type AgentExecutor = (request: AgentExecutionRequest, signal: AbortSignal) => Promise<AgentResult>

export type WorkflowRunInput = {
  id: string
  name: string
  script: string
  args?: unknown
  scriptPath?: string
  parentSessionID?: string
  executor: AgentExecutor
  emit?: (event: WorkflowEvent) => void
  maxConcurrent?: number
  maxAgents?: number
  workerTarget?: string | URL
}

export const MAX_AGENTS_PER_RUN = 1000
const MAX_LOG_LINES = 500

export function defaultConcurrency(cores: number = os.cpus().length || 4): number {
  return Math.min(16, Math.max(2, cores - 2))
}

function workerTarget(): string | URL {
  if (typeof OPENCODE_WORKFLOW_WORKER_PATH !== "undefined" && OPENCODE_WORKFLOW_WORKER_PATH)
    return OPENCODE_WORKFLOW_WORKER_PATH
  return new URL("./worker.ts", import.meta.url)
}

/** FNV-1a content hash; cache keys do not need cryptographic strength. */
export function contentKey(phase: string, options: AgentRequestOptions): string {
  const text = JSON.stringify([options.prompt, options.type ?? "", options.model ?? "", options.variant ?? ""])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${phase}\u0000${(hash >>> 0).toString(16)}`
}

export function renderResult(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

type InflightAgent = {
  state: AgentState
  abort: AbortController
  generation: number
  workerCallID: number
  restart: boolean
}

export class WorkflowRun {
  readonly id: string
  readonly name: string
  readonly script: string
  readonly args: unknown
  scriptPath?: string
  readonly parentSessionID?: string

  private readonly executor: AgentExecutor
  private readonly emitFn: (event: WorkflowEvent) => void
  private readonly maxConcurrent: number
  private readonly maxAgents: number
  private readonly target: string | URL

  private worker?: Worker
  private generation = 0
  private status: RunStatus = "running"
  private readonly startedAt = Date.now()
  private finishedAt?: number
  private resultText?: string
  private errorText?: string
  private readonly logs: LogLine[] = []
  private readonly phases = new Map<string, PhaseState>()
  private readonly agents: AgentState[] = []
  private readonly inflight = new Map<string, InflightAgent>()
  private readonly cache = new Map<string, AgentResult>()
  private readonly queue: (() => Promise<void>)[] = []
  private active = 0
  private agentSeq = 0
  private launched = 0

  private resolveDone!: (result: RunResult) => void
  readonly done: Promise<RunResult>

  constructor(input: WorkflowRunInput) {
    this.id = input.id
    this.name = input.name
    this.script = input.script
    this.args = input.args
    this.scriptPath = input.scriptPath
    this.parentSessionID = input.parentSessionID
    this.executor = input.executor
    this.emitFn = input.emit ?? (() => {})
    this.maxConcurrent = Math.max(1, input.maxConcurrent ?? defaultConcurrency())
    this.maxAgents = Math.max(1, input.maxAgents ?? MAX_AGENTS_PER_RUN)
    this.target = input.workerTarget ?? workerTarget()
    this.done = new Promise<RunResult>((resolve) => {
      this.resolveDone = resolve
    })
  }

  start() {
    this.emitFn({ type: "run.started", run: this.snapshot() })
    this.spawn()
  }

  pause() {
    if (this.status !== "running") return false
    this.status = "paused"
    this.teardownWorker()
    this.emitFn({ type: "run.updated", runID: this.id, status: this.status })
    return true
  }

  resume() {
    if (this.status !== "paused") return false
    this.status = "running"
    this.emitFn({ type: "run.updated", runID: this.id, status: this.status })
    this.spawn()
    return true
  }

  cancel() {
    if (this.status !== "running" && this.status !== "paused") return false
    this.teardownWorker()
    this.finish({ status: "cancelled" })
    return true
  }

  stopAgent(agentID: string) {
    const entry = this.inflight.get(agentID)
    if (!entry) return false
    entry.restart = false
    entry.abort.abort(new Error("Agent stopped by user"))
    return true
  }

  restartAgent(agentID: string) {
    const entry = this.inflight.get(agentID)
    if (!entry) return false
    entry.restart = true
    entry.abort.abort(new Error("Agent restarted by user"))
    return true
  }

  snapshot(): RunSnapshot {
    const agents = this.agents.map((agent) => ({ ...agent, tokens: { ...agent.tokens } }))
    const phaseList = [...this.phases.values()].map((phase) => {
      const members = agents.filter((agent) => agent.phase === phase.name)
      return {
        ...phase,
        agentCount: members.length,
        tokens: members.reduce(
          (acc, agent) => ({ input: acc.input + agent.tokens.input, output: acc.output + agent.tokens.output }),
          { input: 0, output: 0 },
        ),
      }
    })
    return {
      id: this.id,
      name: this.name,
      parentSessionID: this.parentSessionID,
      scriptPath: this.scriptPath,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      result: this.resultText,
      error: this.errorText,
      logs: [...this.logs],
      phases: phaseList,
      agents,
      tokens: agents.reduce(
        (acc, agent) => ({ input: acc.input + agent.tokens.input, output: acc.output + agent.tokens.output }),
        { input: 0, output: 0 },
      ),
      agentTotal: this.launched,
    }
  }

  get currentStatus(): RunStatus {
    return this.status
  }

  private spawn() {
    const generation = ++this.generation
    const worker = new Worker(this.target)
    this.worker = worker
    worker.onmessage = (event: MessageEvent<WorkerToHost>) => {
      if (generation !== this.generation || this.status === "cancelled") return
      this.onWorkerMessage(event.data, generation, worker)
    }
    worker.onerror = (event: ErrorEvent) => {
      if (generation !== this.generation) return
      this.finish({ status: "error", error: event.message || "Workflow worker crashed" })
    }
  }

  private post(worker: Worker, message: HostToWorker) {
    try {
      worker.postMessage(message)
    } catch {
      // worker already terminated
    }
  }

  private onWorkerMessage(message: WorkerToHost, generation: number, worker: Worker) {
    switch (message.type) {
      case "ready":
        this.post(worker, { type: "start", script: this.script, args: this.args })
        return
      case "phase-start": {
        const existing = this.phases.get(message.name)
        if (existing) {
          existing.status = "running"
          existing.finishedAt = undefined
        } else {
          this.phases.set(message.name, { name: message.name, status: "running", startedAt: Date.now() })
          this.emitFn({ type: "phase.started", runID: this.id, name: message.name })
        }
        return
      }
      case "phase-end": {
        const phase = this.phases.get(message.name)
        if (phase) {
          phase.status = "completed"
          phase.finishedAt = Date.now()
        }
        this.emitFn({ type: "phase.finished", runID: this.id, name: message.name })
        return
      }
      case "log": {
        this.logs.push({ time: Date.now(), message: message.message })
        if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
        this.emitFn({ type: "log", runID: this.id, message: message.message })
        return
      }
      case "agent":
        this.onAgentRequest(message, generation, worker)
        return
      case "done":
        this.finish({ status: "completed", result: renderResult(message.result) })
        return
      case "error":
        this.finish({ status: "error", error: message.message })
        return
    }
  }

  private onAgentRequest(message: Extract<WorkerToHost, { type: "agent" }>, generation: number, worker: Worker) {
    const key = contentKey(message.phase, message.options)
    const cached = this.cache.get(key)
    if (cached) {
      this.post(worker, { type: "agent-result", id: message.id, ok: true, value: cached })
      return
    }
    if (this.launched >= this.maxAgents) {
      this.post(worker, {
        type: "agent-result",
        id: message.id,
        ok: false,
        error: `Workflow agent limit reached (${this.maxAgents} agents per run)`,
      })
      return
    }
    this.launched++
    const state: AgentState = {
      id: `a${++this.agentSeq}`,
      phase: message.phase,
      prompt: message.options.prompt,
      type: message.options.type,
      model: message.options.model,
      variant: message.options.variant,
      status: "queued",
      startedAt: Date.now(),
      tokens: { input: 0, output: 0 },
      attempt: 1,
    }
    this.agents.push(state)
    const entry: InflightAgent = {
      state,
      abort: new AbortController(),
      generation,
      workerCallID: message.id,
      restart: false,
    }
    this.inflight.set(state.id, entry)
    this.queue.push(() => this.executeAgent(entry, key, message.options))
    this.pump()
  }

  private pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0 && this.status === "running") {
      const task = this.queue.shift()
      if (!task) return
      this.active++
      void task().finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async executeAgent(entry: InflightAgent, key: string, options: AgentRequestOptions) {
    const { state } = entry
    while (true) {
      if (this.status !== "running" || entry.generation !== this.generation) {
        state.status = "cancelled"
        this.inflight.delete(state.id)
        return
      }
      if (entry.abort.signal.aborted && !entry.restart) {
        this.settleAgent(entry, key, undefined, abortMessage(entry.abort.signal))
        return
      }
      if (entry.abort.signal.aborted && entry.restart) {
        entry.restart = false
        entry.abort = new AbortController()
        state.attempt++
        state.startedAt = Date.now()
      }
      state.status = "running"
      this.emitFn({ type: "agent.started", runID: this.id, agent: { ...state } })
      try {
        const result = await this.executor(
          {
            runID: this.id,
            agentID: state.id,
            phase: state.phase,
            attempt: state.attempt,
            onSession: (sessionID) => {
              state.sessionID = sessionID
            },
            ...options,
          },
          entry.abort.signal,
        )
        if (entry.generation !== this.generation || this.status !== "running") {
          state.status = "cancelled"
          this.inflight.delete(state.id)
          return
        }
        this.settleAgent(entry, key, result, undefined)
        return
      } catch (error) {
        if (entry.restart) continue
        if (entry.generation !== this.generation || this.status !== "running") {
          state.status = "cancelled"
          this.inflight.delete(state.id)
          return
        }
        this.settleAgent(entry, key, undefined, error instanceof Error ? error.message : String(error))
        return
      }
    }
  }

  private settleAgent(entry: InflightAgent, key: string, result: AgentResult | undefined, error: string | undefined) {
    const { state } = entry
    this.inflight.delete(state.id)
    state.finishedAt = Date.now()
    if (result) {
      state.status = "completed"
      state.tokens = { ...result.tokens }
      state.result = result.text
      this.cache.set(key, result)
      if (this.worker && entry.generation === this.generation)
        this.post(this.worker, { type: "agent-result", id: entry.workerCallID, ok: true, value: result })
    } else {
      state.status = entry.abort.signal.aborted ? "cancelled" : "error"
      state.error = error
      if (this.worker && entry.generation === this.generation)
        this.post(this.worker, {
          type: "agent-result",
          id: entry.workerCallID,
          ok: false,
          error: error ?? "Agent failed",
        })
    }
    this.emitFn({ type: "agent.finished", runID: this.id, agent: { ...state } })
  }

  private teardownWorker() {
    const worker = this.worker
    this.worker = undefined
    this.generation++
    if (worker) void worker.terminate()
    for (const entry of [...this.inflight.values()]) {
      entry.restart = false
      entry.abort.abort(new Error("Workflow paused or stopped"))
      entry.state.status = "cancelled"
      entry.state.finishedAt = Date.now()
      this.inflight.delete(entry.state.id)
      this.emitFn({ type: "agent.finished", runID: this.id, agent: { ...entry.state } })
    }
    this.queue.length = 0
  }

  private finish(result: RunResult) {
    if (this.status === "completed" || this.status === "error" || this.status === "cancelled") return
    this.teardownWorker()
    this.status = result.status
    this.finishedAt = Date.now()
    this.resultText = result.result
    this.errorText = result.error
    for (const phase of this.phases.values()) {
      if (phase.status === "running") {
        phase.status = "completed"
        phase.finishedAt = Date.now()
      }
    }
    this.emitFn({
      type: "run.finished",
      runID: this.id,
      status: result.status,
      result: result.result,
      error: result.error,
    })
    this.resolveDone(result)
  }
}

function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === "string") return reason
  return "Agent aborted"
}

export * as WorkflowRunner from "./run"
