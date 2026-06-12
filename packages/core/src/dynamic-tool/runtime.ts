export * as DynamicToolRuntime from "./runtime"

import { ToolFailure } from "@gte-agent/llm"
import { Context, Effect, Layer } from "effect"
import { Config } from "../config"
import { Flag } from "../flag/flag"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "../tool/registry"
import { DynamicToolProtocol } from "./protocol"

/**
 * Executes one dynamic-tool invocation in a sandboxed Bun Worker (fresh worker
 * per call) and proxies the code's `gte(name, args)` calls through
 * `ToolRegistry.execute` under the calling session's identity — so address
 * fallback and the permission regime behave exactly as a direct model call.
 * The proxy is allowlisted to the read-only `gte_*` data tools and capped per
 * invocation; the worker is terminated on settle, timeout, or interrupt.
 */

export const MAX_GTE_CALLS = 32
export const TIMEOUT_MS = 30_000

/**
 * Kill switch: a truthy GTE_AGENT_DISABLE_DYNAMIC_TOOLS or `dynamicTools:
 * { enabled: false }` in config hides the workshop and every saved tool.
 */
export const enabled = Effect.gen(function* () {
  if (Flag.GTE_AGENT_DISABLE_DYNAMIC_TOOLS) return false
  const entries = yield* (yield* Config.Service).entries()
  const merged: Config.Info = Object.assign(
    {},
    ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])),
  )
  return merged.dynamicTools?.enabled !== false
})

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  /** The dynamic tool's registered name, for messages and proxy call IDs. */
  readonly name: string
  readonly code: string
  readonly params: unknown
}

export interface Interface {
  readonly execute: (input: ExecuteInput) => Effect.Effect<unknown, ToolFailure>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/DynamicToolRuntime") {}

export type Options = {
  /** Test seams; production callers use the defaults. */
  readonly timeoutMs?: number
  readonly maxCalls?: number
}

export const layerWith = (options?: Options): Layer.Layer<Service, never, ToolRegistry.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS
      const maxCalls = options?.maxCalls ?? MAX_GTE_CALLS
      const registry = yield* ToolRegistry.Service
      const context = yield* Effect.context()
      const fork = Effect.runForkWith(context)

      const execute: Interface["execute"] = Effect.fn("DynamicToolRuntime.execute")(function* (input) {
        return yield* Effect.callback<unknown, ToolFailure>((resume) => {
          const worker = new Worker(new URL("./worker.ts", import.meta.url))
          const state = { calls: 0, settled: false }
          const post = (message: DynamicToolProtocol.HostToWorker) => {
            try {
              worker.postMessage(message)
            } catch {
              // the worker terminated between the state check and the call
            }
          }
          const settle = (outcome: Effect.Effect<unknown, ToolFailure>) => {
            if (state.settled) return
            state.settled = true
            clearTimeout(timer)
            worker.terminate()
            resume(outcome)
          }
          const timer = setTimeout(
            () =>
              settle(
                Effect.fail(new ToolFailure({ message: `Tool ${input.name} timed out after ${timeoutMs / 1000}s` })),
              ),
            timeoutMs,
          )
          worker.onmessage = (event: MessageEvent<DynamicToolProtocol.WorkerToHost>) => {
            const message = event.data
            if (message.type === "ready") return post({ type: "start", code: input.code, params: input.params })
            if (message.type === "done") return settle(Effect.succeed(message.result))
            if (message.type === "failed") return settle(Effect.fail(new ToolFailure({ message: message.reason })))
            // message.type === "gte": proxy one registry call back to the worker.
            if (state.settled) return
            if (!message.name.startsWith("gte_"))
              return post({
                type: "gte-result",
                id: message.id,
                ok: false,
                error: `gte() can only call the read-only gte_* data tools, not ${message.name}`,
              })
            if (++state.calls > maxCalls)
              return post({
                type: "gte-result",
                id: message.id,
                ok: false,
                error: `gte() call limit reached (${maxCalls} per invocation)`,
              })
            fork(
              registry
                .execute({
                  sessionID: input.sessionID,
                  call: {
                    type: "tool-call",
                    id: `${input.name}_${message.id}`,
                    name: message.name,
                    input: message.params,
                  },
                })
                .pipe(
                  Effect.map((result) =>
                    post(
                      result.type === "error"
                        ? {
                            type: "gte-result",
                            id: message.id,
                            ok: false,
                            error: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
                          }
                        : { type: "gte-result", id: message.id, ok: true, value: result.value },
                    ),
                  ),
                ),
            )
          }
          worker.onerror = (event: ErrorEvent) =>
            settle(Effect.fail(new ToolFailure({ message: event.message || `Tool ${input.name} worker crashed` })))
          // Interruption cleanup: tear the worker down without resuming.
          return Effect.sync(() => {
            state.settled = true
            clearTimeout(timer)
            worker.terminate()
          })
        })
      })

      return Service.of({ execute })
    }),
  )

export const layer = layerWith()
