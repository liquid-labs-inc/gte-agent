/**
 * Session SSE event subscription.
 *
 * Consumes the canonical GET /api/session/:sessionID/event stream, which
 * replays durable session events (after an optional cursor) and then stays
 * open for live events. Works over any fetch — including the in-process
 * worker bridge, which streams response chunks without buffering.
 */

export type SessionEventEnvelope = {
  /**
   * Durable aggregate cursor, usable as the `after` parameter on resubscribe.
   * Ephemeral live-phase events (e.g. `session.panel.*`) carry no cursor and
   * never participate in replay.
   */
  readonly cursor?: number
  readonly event: {
    readonly id: string
    readonly type: string
    readonly data: Record<string, unknown>
  }
}

export type EventSubscriber = (input: {
  sessionID: string
  after?: number
  onEvent: (envelope: SessionEventEnvelope) => void
  onError: (error: Error) => void
}) => () => void

export function createEventSubscriber(input: { baseUrl: string; fetch: typeof fetch }): EventSubscriber {
  return ({ sessionID, after, onEvent, onError }) => {
    const controller = new AbortController()
    const query = after !== undefined ? `?after=${after}` : ""
    const url = `${input.baseUrl}/api/session/${sessionID}/event${query}`

    void (async () => {
      try {
        const response = await input.fetch(url, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`Event stream failed: HTTP ${response.status}`)
        }
        if (!response.body) {
          throw new Error("Event stream has no body")
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf("\n\n")
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const envelope = parseEventBlock(block)
            if (envelope) onEvent(envelope)
            boundary = buffer.indexOf("\n\n")
          }
        }
        if (!controller.signal.aborted) {
          onError(new Error("Event stream ended unexpectedly"))
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof Error && error.name === "AbortError") return
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    })()

    return () => controller.abort()
  }
}

function parseEventBlock(block: string): SessionEventEnvelope | undefined {
  const data: string[] = []
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith("data:")) {
      data.push(line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5))
    }
  }
  if (data.length === 0) return undefined
  try {
    const parsed = JSON.parse(data.join("\n")) as Partial<SessionEventEnvelope>
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (typeof parsed.event !== "object" || parsed.event === null) return undefined
    if (parsed.cursor !== undefined && typeof parsed.cursor !== "number") return undefined
    return parsed as SessionEventEnvelope
  } catch {
    return undefined
  }
}
