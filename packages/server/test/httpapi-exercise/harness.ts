/**
 * Fetch-handler harness for the canonical GTE Agent server.
 *
 * Each `makeServer` call builds an isolated web handler from
 * `createRoutes(password)` — no TCP listener, no shared state. Because
 * `GTE_AGENT_DB` is `":memory:"` (see ./setup.ts) every server instance owns a
 * private database that disappears on `dispose()`.
 */
import "./setup"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createRoutes } from "../../src/routes"

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type RequestSpec = {
  readonly method?: Method
  readonly path: string
  readonly headers?: Record<string, string>
  /** JSON request body. Encoded with `JSON.stringify` and sent as application/json. */
  readonly body?: unknown
}

export type CallResult = {
  readonly status: number
  readonly contentType: string
  readonly headers: Headers
  readonly text: string
  /** Parsed JSON body when the response is application/json, otherwise undefined. */
  readonly body: unknown
}

export type SseEvent = {
  readonly id: string | undefined
  readonly event: string | undefined
  /** Parsed JSON `data:` payload (raw string when not valid JSON). */
  readonly data: unknown
  readonly raw: string
}

export type StreamOptions = {
  /** Stop reading once this predicate is satisfied. Defaults to "at least one event". */
  readonly until?: (events: SseEvent[]) => boolean
  readonly timeoutMs?: number
}

export type StreamResult = {
  readonly status: number
  readonly contentType: string
  readonly events: SseEvent[]
  /** True when the timeout elapsed before `until` was satisfied. */
  readonly timedOut: boolean
}

export type ServerOptions = {
  /** Daemon transport password. When set, requests must carry daemon credentials. */
  readonly password?: string
  /**
   * Environment-style configuration visible to the server's `Config` reads
   * (e.g. `GTE_AGENT_AUTH_MODE`, `GTE_AGENT_AUTH_TOKEN`). The harness installs
   * an explicit `ConfigProvider` per server instance, so ambient `process.env`
   * is never consulted and config-driven behavior is deterministic per
   * scenario. (Effect's default ConfigProvider snapshots `process.env` once
   * per process, so mutating env vars between scenarios would not work.)
   */
  readonly config?: Record<string, string>
}

export type Server = ReturnType<typeof makeServer>

const BASE_URL = "http://gte-agent.test"

function parseFrame(frame: string): SseEvent | undefined {
  let id: string | undefined
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim()
    else if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return undefined
  const raw = dataLines.join("\n")
  let data: unknown = raw
  try {
    data = JSON.parse(raw)
  } catch {
    // keep the raw string
  }
  return { id, event, data, raw }
}

export function makeServer(options: ServerOptions = {}) {
  const web = HttpRouter.toWebHandler(
    createRoutes(options.password).pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.config ?? {} }))),
    ),
    { disableLogger: true },
  )

  function toRequest(spec: RequestSpec): Request {
    const headers = new Headers(spec.headers)
    const init: RequestInit = { method: spec.method ?? "GET", headers }
    if (spec.body !== undefined) {
      init.body = JSON.stringify(spec.body)
      if (!headers.has("content-type")) headers.set("content-type", "application/json")
    }
    return new Request(`${BASE_URL}${spec.path}`, init)
  }

  /** Issue one request and fully read the response. Do not use for SSE routes. */
  async function call(spec: RequestSpec): Promise<CallResult> {
    const response = await web.handler(toRequest(spec))
    const text = await response.text()
    const contentType = response.headers.get("content-type") ?? ""
    let body: unknown
    if (contentType.includes("application/json") && text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
    }
    return { status: response.status, contentType, headers: response.headers, text, body }
  }

  /**
   * Open a (never-ending) SSE response and collect events until `until` is
   * satisfied or the timeout elapses, then cancel the stream.
   */
  async function stream(spec: RequestSpec, options: StreamOptions = {}): Promise<StreamResult> {
    const until = options.until ?? ((events: SseEvent[]) => events.length > 0)
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    const response = await web.handler(toRequest(spec))
    const contentType = response.headers.get("content-type") ?? ""
    const events: SseEvent[] = []
    if (response.status !== 200 || !response.body) {
      return { status: response.status, contentType, events, timedOut: false }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let timedOut = false
    try {
      while (!until(events)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          timedOut = true
          break
        }
        const next = await new Promise<"timeout" | { done: boolean; value?: Uint8Array }>((resolve, reject) => {
          const timer = setTimeout(() => resolve("timeout"), remaining)
          reader.read().then(
            (result) => {
              clearTimeout(timer)
              resolve(result)
            },
            (error: unknown) => {
              clearTimeout(timer)
              reject(error instanceof Error ? error : new Error(String(error)))
            },
          )
        })
        if (next === "timeout") {
          timedOut = true
          break
        }
        if (next.done || next.value === undefined) break
        buffer += decoder.decode(next.value, { stream: true })
        let index = buffer.indexOf("\n\n")
        while (index !== -1) {
          const parsed = parseFrame(buffer.slice(0, index))
          buffer = buffer.slice(index + 2)
          if (parsed) events.push(parsed)
          index = buffer.indexOf("\n\n")
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return { status: response.status, contentType, events, timedOut }
  }

  return { call, stream, dispose: web.dispose }
}
