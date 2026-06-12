// Workflow script sandbox. Runs inside a dedicated Bun Worker spawned by the
// workflow runtime. The orchestration script is evaluated as the body of an
// async function whose only bindings are the injected workflow API
// (phase/agent/map/log/args); ambient capabilities (Bun, process, fetch,
// require, ...) are stripped from the worker global scope and shadowed as
// undefined parameters before the script runs (shared hardening, see
// ../sandbox/hardening.ts). Defense in depth, not a hard security boundary:
// the script can only coordinate, and the agents it spawns act under the
// unchanged session tool and permission regime.
import { AsyncLocalStorage } from "async_hooks"
import { SandboxHardening } from "../sandbox/hardening"
import { DEFAULT_PHASE, WorkflowProtocol } from "./protocol"

declare var self: Worker

// Captured before sanitize() strips the messaging globals from script scope.
const post = postMessage.bind(globalThis) as (message: WorkflowProtocol.WorkerToHost) => void

const phaseStorage = new AsyncLocalStorage<string>()
const pending = new Map<
  number,
  { resolve: (value: WorkflowProtocol.AgentResult) => void; reject: (error: Error) => void }
>()
const state = { started: false, agentSeq: 0 }

function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof name !== "string" || !name.trim()) return Promise.reject(new Error("phase() requires a non-empty name"))
  if (typeof fn !== "function") return Promise.reject(new Error("phase() requires a function"))
  const active = phaseStorage.getStore()
  if (active !== undefined)
    return Promise.reject(new Error(`phase("${name}") cannot be nested inside phase("${active}")`))
  post({ type: "phase-started", name })
  return phaseStorage.run(name, () =>
    Promise.resolve()
      .then(fn)
      .finally(() => post({ type: "phase-ended", name })),
  )
}

function agent(request: WorkflowProtocol.AgentRequest): Promise<WorkflowProtocol.AgentResult> {
  if (!request || typeof request.prompt !== "string" || !request.prompt.trim())
    return Promise.reject(new Error("agent() requires a non-empty prompt"))
  const id = ++state.agentSeq
  const message: WorkflowProtocol.WorkerToHost = {
    type: "agent",
    id,
    phase: phaseStorage.getStore() ?? DEFAULT_PHASE,
    request: {
      prompt: request.prompt,
      ...(request.type ? { type: String(request.type) } : {}),
      ...(request.model ? { model: String(request.model) } : {}),
      ...(request.variant ? { variant: String(request.variant) } : {}),
    },
  }
  return new Promise<WorkflowProtocol.AgentResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post(message)
  })
}

async function map<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: { concurrency?: number },
): Promise<R[]> {
  if (!Array.isArray(items)) throw new Error("map() requires an array")
  if (typeof fn !== "function") throw new Error("map() requires a function")
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? 16))
  const results: R[] = []
  const cursor = { next: 0 }
  const lane = async () => {
    while (cursor.next < items.length) {
      const index = cursor.next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()))
  return results
}

function log(message: unknown) {
  post({ type: "log", message: typeof message === "string" ? message : String(message) })
}

async function run(script: string, args: unknown) {
  // The script is the body of an async function: top-level `await` and
  // `return` both work, and the only bindings in scope are the workflow API.
  // AsyncFunction is the hardening module's load-time capture; sanitize() has
  // since poisoned the live `.constructor` so the script body cannot re-derive it.
  const fn = new SandboxHardening.AsyncFunction(
    "phase",
    "agent",
    "map",
    "log",
    "args",
    ...SandboxHardening.BANNED_GLOBALS,
    `"use strict";\n${script}`,
  )
  return await fn(phase, agent, map, log, args, ...SandboxHardening.BANNED_GLOBALS.map(() => undefined))
}

/** Results cross postMessage; non-clonable values degrade to their JSON shape or string. */
function serializable(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

/** Script failures must always surface a readable reason, never an empty string. */
function reason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  const text = String(error)
  if (text && text !== "[object Object]" && text !== "Error") return text
  return "Workflow script failed"
}

self.onmessage = (event: MessageEvent<WorkflowProtocol.HostToWorker>) => {
  const message = event.data
  if (message.type === "start") {
    if (state.started) return
    state.started = true
    SandboxHardening.sanitize()
    run(message.script, message.args)
      .then((result) => post({ type: "done", result: serializable(result) }))
      .catch((error: unknown) => post({ type: "failed", reason: reason(error) }))
    return
  }
  if (message.type === "agent-result") {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.ok) return waiter.resolve(message.value)
    waiter.reject(new Error(message.error || "Workflow agent failed"))
  }
}

post({ type: "ready" })
