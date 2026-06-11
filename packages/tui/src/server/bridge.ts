/**
 * Main-thread side of the in-process server channel.
 *
 * Spawns the worker that hosts the canonical GTE Agent server and exposes a
 * fetch-compatible function that serializes requests over postMessage and
 * rebuilds streaming `Response` objects from chunk messages. Cancelling a
 * response body (for example unsubscribing from the session SSE stream)
 * aborts the matching request inside the worker.
 */
import type { FromWorkerMessage, ToWorkerMessage } from "./protocol"
import { VIRTUAL_ORIGIN } from "./protocol"

export { VIRTUAL_ORIGIN }

export interface ServerBridge {
  /** Virtual origin served by the in-process channel. */
  readonly origin: string
  /** fetch-compatible function routed to the worker-hosted server. */
  readonly fetch: typeof fetch
  /** Start a real TCP listener inside the worker (explicit opt-in). */
  listen(input: { hostname: string; port: number }): Promise<{ url: string }>
  /** Stop the listener (if any), dispose the server, and terminate the worker. */
  shutdown(): Promise<void>
}

type PendingResponse = {
  resolveHead: (response: Response) => void
  rejectHead: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  settledHead: boolean
  done: boolean
}

type PendingCall = {
  resolve: (message: FromWorkerMessage) => void
  reject: (error: Error) => void
}

const READY_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 5_000

export async function startServerBridge(options?: {
  workerEnv?: Record<string, string | undefined>
}): Promise<ServerBridge> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    env: { ...process.env, ...options?.workerEnv } as Record<string, string>,
  } as WorkerOptions)

  let nextID = 1
  const responses = new Map<number, PendingResponse>()
  const calls = new Map<number, PendingCall>()
  let terminated = false

  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const failAll = (error: Error) => {
    for (const pending of responses.values()) {
      if (!pending.settledHead) pending.rejectHead(error)
      else if (!pending.done) pending.controller?.error(error)
      pending.done = true
    }
    responses.clear()
    for (const call of calls.values()) call.reject(error)
    calls.clear()
  }

  worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
    const message = event.data
    switch (message.type) {
      case "ready":
        resolveReady()
        return
      case "listen-result":
      case "shutdown-result": {
        const call = calls.get(message.id)
        if (call) {
          calls.delete(message.id)
          call.resolve(message)
        }
        return
      }
      case "response-head": {
        const pending = responses.get(message.id)
        if (!pending || pending.settledHead) return
        pending.settledHead = true
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            pending.controller = controller
          },
          cancel() {
            pending.done = true
            responses.delete(message.id)
            if (!terminated) worker.postMessage({ type: "abort", id: message.id } satisfies ToWorkerMessage)
          },
        })
        const headers = new Headers()
        for (const [name, value] of message.headers) headers.append(name, value)
        const status = message.status
        // Response bodies are not allowed for null-body statuses.
        const bodyAllowed = status !== 204 && status !== 205 && status !== 304
        pending.resolveHead(
          new Response(bodyAllowed ? body : null, {
            status,
            statusText: message.statusText,
            headers,
          }),
        )
        if (!bodyAllowed) {
          pending.done = true
        }
        return
      }
      case "response-chunk": {
        const pending = responses.get(message.id)
        if (!pending || pending.done) return
        pending.controller?.enqueue(message.chunk)
        return
      }
      case "response-end": {
        const pending = responses.get(message.id)
        if (!pending) return
        responses.delete(message.id)
        if (!pending.settledHead) {
          pending.rejectHead(new Error("Server closed the request before responding"))
          return
        }
        if (!pending.done) {
          pending.done = true
          try {
            pending.controller?.close()
          } catch {
            // Stream may already be cancelled.
          }
        }
        return
      }
      case "response-error": {
        const pending = responses.get(message.id)
        if (!pending) return
        responses.delete(message.id)
        const error = new Error(message.message)
        if (!pending.settledHead) pending.rejectHead(error)
        else if (!pending.done) pending.controller?.error(error)
        pending.done = true
        return
      }
    }
  }

  worker.onerror = (event: ErrorEvent) => {
    const error = new Error(event.message || "GTE Agent server worker crashed")
    rejectReady(error)
    failAll(error)
  }

  // Bun fires "close" when the worker exits for any reason (crash,
  // process.exit, terminate). Without this, a worker death that does not
  // raise an ErrorEvent would leave every in-flight request hanging.
  worker.addEventListener("close", () => {
    if (terminated) return
    terminated = true
    const error = new Error("GTE Agent server worker exited unexpectedly")
    rejectReady(error)
    failAll(error)
  })

  function send(message: ToWorkerMessage) {
    if (terminated) throw new Error("GTE Agent server worker is shut down")
    worker.postMessage(message)
  }

  const bridgeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), VIRTUAL_ORIGIN), init)
    const id = nextID++
    const bytes = request.method === "GET" || request.method === "HEAD" ? null : new Uint8Array(await request.arrayBuffer())
    const pending: PendingResponse = {
      resolveHead: () => {},
      rejectHead: () => {},
      settledHead: false,
      done: false,
    }
    const head = new Promise<Response>((resolve, reject) => {
      pending.resolveHead = resolve
      pending.rejectHead = reject
    })
    responses.set(id, pending)
    if (request.signal) {
      if (request.signal.aborted) {
        responses.delete(id)
        throw new DOMException("The operation was aborted.", "AbortError")
      }
      request.signal.addEventListener(
        "abort",
        () => {
          const current = responses.get(id)
          if (!current) return
          responses.delete(id)
          current.done = true
          if (!current.settledHead) {
            current.rejectHead(new DOMException("The operation was aborted.", "AbortError"))
          } else {
            try {
              current.controller?.error(new DOMException("The operation was aborted.", "AbortError"))
            } catch {
              // Stream may already be closed.
            }
          }
          if (!terminated) worker.postMessage({ type: "abort", id } satisfies ToWorkerMessage)
        },
        { once: true },
      )
    }
    send({
      type: "request",
      id,
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      body: bytes,
    })
    return head
  }) as typeof fetch

  function call(message: ToWorkerMessage & { id: number }) {
    return new Promise<FromWorkerMessage>((resolve, reject) => {
      calls.set(message.id, { resolve, reject })
      try {
        send(message)
      } catch (error) {
        calls.delete(message.id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const timeout = setTimeout(() => rejectReady(new Error("Timed out waiting for the GTE Agent server worker")), READY_TIMEOUT_MS)
  try {
    await ready
  } catch (error) {
    worker.terminate()
    throw error
  } finally {
    clearTimeout(timeout)
  }

  return {
    origin: VIRTUAL_ORIGIN,
    fetch: bridgeFetch,
    async listen(input) {
      const result = await call({ type: "listen", id: nextID++, hostname: input.hostname, port: input.port })
      if (result.type !== "listen-result") throw new Error("Unexpected worker reply")
      if (result.error !== undefined || result.url === undefined) {
        throw new Error(result.error ?? "Failed to start listener")
      }
      return { url: result.url }
    },
    async shutdown() {
      if (terminated) return
      const id = nextID++
      const ack = call({ type: "shutdown", id }).catch(() => undefined)
      const timer = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))
      await Promise.race([ack, timer])
      terminated = true
      failAll(new Error("GTE Agent server worker is shut down"))
      worker.terminate()
    },
  }
}
