import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createApi } from "../src/api/client"
import { createEventSubscriber, type SessionEventEnvelope } from "../src/api/events"
import { startServerBridge, VIRTUAL_ORIGIN, type ServerBridge } from "../src/server/bridge"

let bridge: ServerBridge
let home: string

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "gta-bridge-test-"))
  bridge = await startServerBridge({
    workerEnv: {
      GTE_AGENT_HOME: home,
      GTE_AGENT_DB: ":memory:",
      GTE_AGENT_AUTH_MODE: "disabled",
    },
  })
})

afterAll(async () => {
  await bridge?.shutdown()
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

test("worker serves /api/health over the in-process channel", async () => {
  const response = await bridge.fetch(`${VIRTUAL_ORIGIN}/api/health`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ healthy: true })
})

test("relative URLs resolve against the virtual origin", async () => {
  const response = await bridge.fetch("/api/health")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ healthy: true })
})

test("session create + prompt streams demo runner output over bridged SSE", async () => {
  const api = createApi({ baseUrl: VIRTUAL_ORIGIN, fetch: bridge.fetch })

  expect(await api.health()).toBe(true)

  const session = await api.createSession({ directory: home })
  expect(session.principalID).toBe("dev_principal")
  expect(session.authorityID).toBe("dev_authority")

  const sessions = await api.listSessions()
  expect(sessions.map((item) => String(item.id))).toContain(String(session.id))

  const events: SessionEventEnvelope[] = []
  const subscribe = createEventSubscriber({ baseUrl: VIRTUAL_ORIGIN, fetch: bridge.fetch })

  let resolveText!: (text: string) => void
  let rejectText!: (error: Error) => void
  const streamedText = new Promise<string>((resolve, reject) => {
    resolveText = resolve
    rejectText = reject
  })
  const unsubscribe = subscribe({
    sessionID: String(session.id),
    onEvent: (envelope) => {
      events.push(envelope)
      if (envelope.event.type === "session.next.text.ended") {
        resolveText(String(envelope.event.data["text"]))
      }
    },
    onError: rejectText,
  })

  await api.prompt(String(session.id), "hello demo runner")

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timed out waiting for streamed text")), 15_000),
  )
  const text = await Promise.race([streamedText, timeout])
  expect(text).toBe("GTE Agent demo response.")

  // The SSE stream stays live: an unsubscribe must abort the in-worker request
  // without tearing down the bridge.
  unsubscribe()

  const types = events.map((envelope) => envelope.event.type)
  expect(types).toContain("session.created")
  expect(types).toContain("session.next.prompt.admitted")
  expect(types).toContain("session.next.step.started")

  // Replay after a cursor: resubscribing from the recorded cursor replays the
  // remaining durable events.
  const firstCursor = events[0].cursor
  const replayed: string[] = []
  const replayedDone = new Promise<void>((resolve) => {
    const stop = subscribe({
      sessionID: String(session.id),
      after: firstCursor,
      onEvent: (envelope) => {
        replayed.push(envelope.event.type)
        if (envelope.event.type === "session.next.step.ended") {
          stop()
          resolve()
        }
      },
      onError: () => {},
    })
  })
  await Promise.race([
    replayedDone,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("replay timed out")), 15_000)),
  ])
  expect(replayed).not.toContain("session.created")
  expect(replayed).toContain("session.next.text.ended")

  // History endpoint returns the user + assistant messages.
  const messages = await api.messages(String(session.id))
  const kinds = messages.map((message) => message.type)
  expect(kinds).toContain("user")
  expect(kinds).toContain("assistant")
})

test("listen starts a real HTTP listener on demand", async () => {
  const { url } = await bridge.listen({ hostname: "127.0.0.1", port: 0 })
  const trimmed = url.endsWith("/") ? url.slice(0, -1) : url
  const response = await fetch(`${trimmed}/api/health`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ healthy: true })
})
