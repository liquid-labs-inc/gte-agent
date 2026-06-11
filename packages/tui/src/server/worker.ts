/**
 * Worker entry hosting the canonical GTE Agent server.
 *
 * The worker serves requests through `webHandler()` from @gte-agent/server —
 * no TCP listener exists unless the main thread explicitly asks for one via
 * a "listen" message (gta --listen/--port/--hostname).
 *
 * Response bodies are pumped back to the main thread chunk by chunk so SSE
 * responses stream instead of buffering behind a single text body.
 */
import { webHandler } from "@gte-agent/server/routes"
import type { BridgeListenMessage, BridgeRequestMessage, FromWorkerMessage, ToWorkerMessage } from "./protocol"

declare var self: Worker

const { handler, dispose } = webHandler()

const pending = new Map<number, AbortController>()
let listener: ReturnType<typeof Bun.serve> | undefined

function post(message: FromWorkerMessage) {
  self.postMessage(message)
}

async function serveRequest(message: BridgeRequestMessage) {
  const controller = new AbortController()
  pending.set(message.id, controller)
  try {
    const request = new Request(message.url, {
      method: message.method,
      headers: message.headers.map(([name, value]) => [name, value]),
      body: message.body && message.body.byteLength > 0 ? (message.body as Uint8Array<ArrayBuffer>) : undefined,
      signal: controller.signal,
    })
    const response = await handler(request)
    post({
      type: "response-head",
      id: message.id,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
    })
    if (!response.body) {
      post({ type: "response-end", id: message.id })
      return
    }
    const reader = response.body.getReader()
    const abort = () => void reader.cancel().catch(() => {})
    controller.signal.addEventListener("abort", abort, { once: true })
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (controller.signal.aborted) break
        post({ type: "response-chunk", id: message.id, chunk: value })
      }
      post({ type: "response-end", id: message.id })
    } finally {
      controller.signal.removeEventListener("abort", abort)
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      post({
        type: "response-error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      })
    } else {
      post({ type: "response-end", id: message.id })
    }
  } finally {
    pending.delete(message.id)
  }
}

function listen(message: BridgeListenMessage) {
  try {
    void listener?.stop(true)
    listener = Bun.serve({
      hostname: message.hostname,
      port: message.port,
      idleTimeout: 0,
      fetch: (request) => handler(request),
    })
    post({ type: "listen-result", id: message.id, url: listener.url.toString() })
  } catch (error) {
    post({
      type: "listen-result",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function shutdown(id: number) {
  for (const controller of pending.values()) controller.abort()
  pending.clear()
  void listener?.stop(true)
  listener = undefined
  await dispose().catch(() => {})
  post({ type: "shutdown-result", id })
}

self.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const message = event.data
  switch (message.type) {
    case "request":
      void serveRequest(message)
      break
    case "abort":
      pending.get(message.id)?.abort()
      break
    case "listen":
      listen(message)
      break
    case "shutdown":
      void shutdown(message.id)
      break
  }
}

post({ type: "ready" })
