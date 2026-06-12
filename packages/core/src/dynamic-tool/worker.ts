// Dynamic tool sandbox. Runs inside a dedicated Bun Worker spawned by the
// dynamic-tool runtime, one worker per invocation. The tool code is evaluated
// as the body of an async function whose only bindings are `params` (the
// decoded call arguments) and `gte(name, args)` (a host-proxied call into the
// session's tool registry, allowlisted host-side to gte_* read-only data
// tools); ambient capabilities are stripped and shadowed by the shared
// hardening (see ../sandbox/hardening.ts). Defense in depth, not a hard
// security boundary: everything the code can actually do flows through the
// unchanged session tool and permission regime.
import { SandboxHardening } from "../sandbox/hardening"
import { DynamicToolProtocol } from "./protocol"

declare var self: Worker

// Captured before sanitize() strips the messaging globals from script scope.
const post = postMessage.bind(globalThis) as (message: DynamicToolProtocol.WorkerToHost) => void

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const state = { started: false, callSeq: 0 }

function gte(name: unknown, params?: unknown): Promise<unknown> {
  if (typeof name !== "string" || !name.trim())
    return Promise.reject(new Error("gte() requires a tool name, e.g. gte('gte_market_data', { market: 'BTC' })"))
  const id = ++state.callSeq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ type: "gte", id, name, params: params ?? {} })
  })
}

async function run(code: string, params: unknown) {
  // The code is the body of an async function: top-level `await` and `return`
  // both work, and the only bindings in scope are `params` and `gte`.
  // AsyncFunction is the hardening module's load-time capture; sanitize() has
  // since poisoned the live `.constructor` so the code cannot re-derive it.
  const fn = new SandboxHardening.AsyncFunction(
    "params",
    "gte",
    ...SandboxHardening.BANNED_GLOBALS,
    `"use strict";\n${code}`,
  )
  return await fn(params, gte, ...SandboxHardening.BANNED_GLOBALS.map(() => undefined))
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

/** Failures must always surface a readable reason, never an empty string. */
function reason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  const text = String(error)
  if (text && text !== "[object Object]" && text !== "Error") return text
  return "Tool code failed"
}

self.onmessage = (event: MessageEvent<DynamicToolProtocol.HostToWorker>) => {
  const message = event.data
  if (message.type === "start") {
    if (state.started) return
    state.started = true
    SandboxHardening.sanitize()
    run(message.code, message.params)
      .then((result) => post({ type: "done", result: serializable(result) }))
      .catch((error: unknown) => post({ type: "failed", reason: reason(error) }))
    return
  }
  if (message.type === "gte-result") {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.ok) return waiter.resolve(message.value)
    waiter.reject(new Error(message.error || "gte() call failed"))
  }
}

post({ type: "ready" })
