// Workflow script sandbox. Runs inside a dedicated Bun Worker spawned by the
// workflow runtime. The orchestration script is evaluated as the body of an
// async function whose only capabilities are the injected workflow API
// (phase/agent/map/log/args). Ambient capabilities (Bun, process, fetch,
// require, ...) are stripped from the worker global scope before the script
// runs; the script coordinates while agents do all reading/writing/running.
import { AsyncLocalStorage } from "async_hooks"
import type { AgentRequestOptions, AgentResult, HostToWorker, WorkerToHost } from "./protocol"
import { DEFAULT_PHASE } from "./protocol"

declare var self: Worker

// Capture what the host shim needs before the sandbox strips globals.
const post: (message: WorkerToHost) => void = postMessage.bind(globalThis)

const phaseStorage = new AsyncLocalStorage<string>()
const pending = new Map<number, { resolve: (value: AgentResult) => void; reject: (error: Error) => void }>()

const state = {
  started: false,
  agentSeq: 0,
}

// Capabilities stripped from the script's scope. Each is removed from the
// worker global where possible AND shadowed as an `undefined` parameter of
// the script function, so direct references always see undefined.
const BANNED_GLOBALS = [
  "Bun",
  "process",
  "require",
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "Worker",
  "navigator",
] as const

function sanitize() {
  const globals = globalThis as Record<string, unknown>
  for (const key of BANNED_GLOBALS) {
    try {
      delete globals[key]
    } catch {
      // ignore non-configurable globals
    }
    try {
      Object.defineProperty(globals, key, { value: undefined, configurable: false, writable: false })
    } catch {
      // non-configurable getter; the parameter shadowing below still hides it
      // from the script body, and validation rejects import()/import.meta.
    }
  }
}

function api() {
  function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (typeof name !== "string" || !name.trim()) return Promise.reject(new Error("phase() requires a name"))
    if (typeof fn !== "function") return Promise.reject(new Error("phase() requires a function"))
    post({ type: "phase-start", name })
    return phaseStorage.run(name, () =>
      Promise.resolve()
        .then(fn)
        .finally(() => post({ type: "phase-end", name })),
    )
  }

  function agent(options: AgentRequestOptions): Promise<AgentResult> {
    if (!options || typeof options.prompt !== "string" || !options.prompt.trim())
      return Promise.reject(new Error("agent() requires a prompt"))
    const id = ++state.agentSeq
    const request: WorkerToHost = {
      type: "agent",
      id,
      phase: phaseStorage.getStore() ?? DEFAULT_PHASE,
      options: {
        prompt: options.prompt,
        ...(options.type ? { type: options.type } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.variant ? { variant: options.variant } : {}),
      },
    }
    return new Promise<AgentResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      post(request)
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
    const results: R[] = new Array(items.length)
    let next = 0
    const lane = async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await fn(items[index], index)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => lane()),
    )
    return results
  }

  function log(message: unknown) {
    post({ type: "log", message: typeof message === "string" ? message : String(message) })
  }

  return { phase, agent, map, log }
}

async function run(script: string, args: unknown) {
  const { phase, agent, map, log } = api()
  // The script is the body of an async function: top-level `await` and
  // `return` both work, and the only bindings in scope are the workflow API.
  const AsyncFunction = async function () {}.constructor as new (
    ...params: string[]
  ) => (...args: unknown[]) => Promise<unknown>
  const fn = new AsyncFunction("phase", "agent", "map", "log", "args", ...BANNED_GLOBALS, `"use strict";\n${script}`)
  return await fn(phase, agent, map, log, args, ...BANNED_GLOBALS.map(() => undefined))
}

self.onmessage = (event: MessageEvent<HostToWorker>) => {
  const message = event.data
  if (message.type === "start") {
    if (state.started) return
    state.started = true
    sanitize()
    run(message.script, message.args)
      .then((result) => {
        post({ type: "done", result: serializable(result) })
      })
      .catch((error: unknown) => {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      })
    return
  }
  if (message.type === "agent-result") {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.ok) waiter.resolve(message.value)
    else waiter.reject(new Error(message.error))
  }
}

function serializable(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

post({ type: "ready" })
