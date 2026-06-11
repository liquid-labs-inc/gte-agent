import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { readAuthStatus } from "../src/api/auth"
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createGteApi } from "../src/api/gte"
import { App } from "../src/ui/app"
import { createMockApi, makeSession } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

let active: TestRendererSetup | undefined

afterEach(() => {
  if (active && !active.renderer.isDestroyed) active.renderer.destroy()
  active = undefined
})

function mount(mock: ReturnType<typeof createMockApi>, options?: { onExit?: () => void }) {
  return testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: mock.fetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        pollIntervalMs={40}
        onExit={options?.onExit ?? (() => {})}
      />
    ),
    { width: 120, height: 40 },
  )
}

test("boots and renders the main layout with auth-stub status and reserved data workspace", async () => {
  const mock = createMockApi()
  active = await mount(mock)

  const frame = await active.waitForFrame((current) => current.includes("GTE Agent"))
  expect(frame).toContain("GTE Agent")
  expect(frame).toContain("sessions")
  // Data workspace: honest empty state, no fake data.
  expect(frame).toContain("No data panels pinned")
  expect(frame).toContain("market: —")
  expect(frame).toContain("tracked address: —")
  // Auth-stub status (disabled mode + synthetic principal/authority).
  expect(frame).toContain("auth disabled (stub)")
  expect(frame).toContain("dev_principal")
  expect(frame).toContain("dev_authority")
  // Server status: in-process worker, no TCP listener.
  expect(frame).toContain("server up")
  expect(frame).toContain("in-process worker")
})

test("session list renders sessions from the canonical list route", async () => {
  const mock = createMockApi({
    sessions: [
      makeSession({ id: "ses_alpha", title: "alpha session" }),
      makeSession({ id: "ses_beta", title: "beta session" }),
    ],
  })
  active = await mount(mock)

  const frame = await active.waitForFrame((current) => current.includes("alpha session"))
  expect(frame).toContain("+ new session")
  expect(frame).toContain("alpha session")
  expect(frame).toContain("beta session")
})

test("opening a session replays history and streams events into the transcript", async () => {
  const mock = createMockApi({
    sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })],
    messages: {
      ses_alpha: [{ id: "msg_u0", type: "user", text: "earlier question", time: { created: 1 } }],
    },
  })
  active = await mount(mock)

  await active.waitForFrame((current) => current.includes("alpha session"))

  // First option is "+ new session"; move down to the session and open it.
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()

  // History replays from the messages endpoint.
  const history = await active.waitForFrame((current) => current.includes("earlier question"))
  expect(history).toContain("ses_alpha")

  await active.waitFor(() => mock.hasStream("ses_alpha"))

  // Live events stream into the transcript incrementally.
  mock.emit("ses_alpha", {
    cursor: 10,
    event: {
      id: "evt_10",
      type: "session.next.prompt.admitted",
      data: { messageID: "msg_u1", prompt: { text: "hello demo" } },
    },
  })
  mock.emit("ses_alpha", {
    cursor: 11,
    event: { id: "evt_11", type: "session.next.step.started", data: { assistantMessageID: "msg_a1" } },
  })
  mock.emit("ses_alpha", {
    cursor: 12,
    event: {
      id: "evt_12",
      type: "session.next.text.started",
      data: { assistantMessageID: "msg_a1", textID: "t1" },
    },
  })
  mock.emit("ses_alpha", {
    cursor: 13,
    event: {
      id: "evt_13",
      type: "session.next.text.ended",
      data: { assistantMessageID: "msg_a1", textID: "t1", text: "GTE Agent demo response." },
    },
  })

  const streamed = await active.waitForFrame((current) => current.includes("GTE Agent demo response."))
  expect(streamed).toContain("hello demo")
  // Step has not ended yet: session status shows streaming.
  expect(streamed).toContain("streaming")

  mock.emit("ses_alpha", {
    cursor: 14,
    event: { id: "evt_14", type: "session.next.step.ended", data: { assistantMessageID: "msg_a1" } },
  })
  const idle = await active.waitForFrame((current) => current.includes("idle"))
  expect(idle).toContain("GTE Agent demo response.")
})

test("submitting a prompt posts to the canonical prompt route", async () => {
  const mock = createMockApi({
    sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })],
  })
  active = await mount(mock)

  await active.waitForFrame((current) => current.includes("alpha session"))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((current) => current.includes("prompt"))

  await active.mockInput.typeText("hello from the tui")
  active.mockInput.pressEnter()

  await active.waitFor(() => mock.prompts.length > 0)
  expect(mock.prompts[0]).toEqual({ sessionID: "ses_alpha", text: "hello from the tui" })
})

test("navigating away while history loads does not leak the stale session into the new one", async () => {
  const mock = createMockApi({
    sessions: [
      makeSession({ id: "ses_alpha", title: "alpha session" }),
      makeSession({ id: "ses_beta", title: "beta session" }),
    ],
    messages: {
      ses_alpha: [{ id: "msg_a", type: "user", text: "alpha history", time: { created: 1 } }],
      ses_beta: [{ id: "msg_b", type: "user", text: "beta history", time: { created: 1 } }],
    },
  })
  // Gate the alpha history request so it resolves only after the user has
  // already navigated to beta.
  let releaseAlpha!: () => void
  const alphaGate = new Promise<void>((resolve) => {
    releaseAlpha = resolve
  })
  const gatedFetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.pathname === "/api/session/ses_alpha/message") await alphaGate
    return mock.fetch(request as never, init)
  }) as typeof globalThis.fetch

  active = await testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: gatedFetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: gatedFetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: gatedFetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        onExit={() => {}}
      />
    ),
    { width: 100, height: 32 },
  )

  await active.waitForFrame((current) => current.includes("alpha session"))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((current) => current.includes("loading history"))

  // Back out while alpha's history is still in flight, then open beta.
  active.mockInput.pressKey("ESCAPE")
  await active.waitForFrame((current) => current.includes("beta session"))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((current) => current.includes("beta history"))
  await active.waitFor(() => mock.hasStream("ses_beta"))

  // The stale alpha load resolves now: it must not clobber beta's transcript
  // and must not subscribe to alpha's event stream.
  releaseAlpha()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const frame = await active.waitForFrame((current) => current.includes("beta history"))
  expect(frame).not.toContain("alpha history")
  expect(mock.hasStream("ses_alpha")).toBe(false)
  expect(mock.hasStream("ses_beta")).toBe(true)
})

test("errors from the API surface in the error banner", async () => {
  const mock = createMockApi()
  const failingFetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    if (url.pathname === "/api/session") {
      return new Response(JSON.stringify({ _tag: "UnknownError", message: "list exploded" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    return mock.fetch(request as never, init)
  }) as typeof globalThis.fetch

  active = await testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: failingFetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: failingFetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: failingFetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        onExit={() => {}}
      />
    ),
    { width: 100, height: 32 },
  )

  const frame = await active.waitForFrame((current) => current.includes("error:"))
  expect(frame).toContain("list exploded")
})
