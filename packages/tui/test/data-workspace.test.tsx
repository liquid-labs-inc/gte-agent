/**
 * Component coverage for the M5 data workspace flow:
 *
 * - slash command → intent PATCH + snapshot POST → live panel renders
 * - ephemeral session.panel.updated events (no cursor) refresh the panel
 *   without growing the transcript
 * - degraded panels show the snapshot-fallback label and poll the one-shot
 *   HTTP route
 * - reopening a session restores panels from durable intent (seed path)
 */
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { TestRendererSetup } from "@opentui/core/testing"
import { readAuthStatus } from "../src/api/auth"
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createGteApi } from "../src/api/gte"
import { createModelsApi } from "../src/api/models"
import { createWorkflowsApi } from "../src/api/workflows"
import { App } from "../src/ui/app"
import { createMockApi, makeSession } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

let active: TestRendererSetup | undefined

afterEach(() => {
  if (active && !active.renderer.isDestroyed) active.renderer.destroy()
  active = undefined
})

function mount(mock: ReturnType<typeof createMockApi>) {
  return testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        models={createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        workflows={createWorkflowsApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: mock.fetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        pollIntervalMs={40}
        onExit={() => {}}
      />
    ),
    { width: 130, height: 44 },
  )
}

async function openFirstSession(mock: ReturnType<typeof createMockApi>, title: string, sessionID: string) {
  active = await mount(mock)
  await active.waitForFrame((current) => current.includes(title))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((current) => current.includes("prompt"))
  await active.waitFor(() => mock.hasStream(sessionID))
}

test("a slash command patches intent, records a snapshot, and renders the live panel", async () => {
  const mock = createMockApi({ sessions: [makeSession({ id: "ses_data", title: "data session" })] })
  await openFirstSession(mock, "data session", "ses_data")

  await active!.mockInput.typeText("/book eth-usd")
  active!.mockInput.pressEnter()

  // Intent PATCH + snapshot POST hit the canonical routes.
  await active!.waitFor(() => mock.intentPatches.length > 0 && mock.snapshots.length > 0)
  expect(mock.intentPatches[0].patch).toEqual({
    pinnedPanels: [{ panel: "book", key: "ETH-USD" }],
    selectedMarket: "ETH-USD",
  })
  expect(mock.snapshots[0].body.command).toBe("/book")

  // Panel appears in the workspace (driven by the intent.updated SSE event),
  // the primary market is displayed, and the durable snapshot lands in the
  // transcript.
  const frame = await active!.waitForFrame(
    (current) => current.includes("book ETH-USD") && current.includes("market: ETH-USD"),
  )
  expect(frame).toContain("[data] /book ETH-USD")
  expect(frame).toContain("env: hyperliquid-dev")
  // No prompt was sent to the agent for a slash command.
  expect(mock.prompts).toEqual([])
})

test("ephemeral panel updates re-render the panel without growing the transcript", async () => {
  const mock = createMockApi({ sessions: [makeSession({ id: "ses_live", title: "live session" })] })
  await openFirstSession(mock, "live session", "ses_live")

  await active!.mockInput.typeText("/trades eth-usd")
  active!.mockInput.pressEnter()
  await active!.waitForFrame((current) => current.includes("trades ETH-USD"))

  const snapshotsBefore = mock.snapshots.length

  // Live status then two throttled updates, exactly as the panel manager
  // publishes them: ephemeral envelopes WITHOUT cursors.
  mock.emit("ses_live", {
    event: {
      id: "evt_p1",
      type: "session.panel.status",
      data: { sessionID: "ses_live", panel: "trades", key: "ETH-USD", status: "live" },
    },
  })
  mock.emit("ses_live", {
    event: {
      id: "evt_p2",
      type: "session.panel.updated",
      data: {
        sessionID: "ses_live",
        panel: "trades",
        key: "ETH-USD",
        data: [{ price: "2001.5", size: "1" }],
        provenance: { env: "hyperliquid-dev", source: "ws", timestamp: "2026-06-11T01:02:03.000Z", symbol: "ETH-USD" },
      },
    },
  })

  const frame = await active!.waitForFrame((current) => current.includes("2001.5"))
  expect(frame).toContain("live ws 01:02:03")
  // Continuous updates never create transcript snapshots.
  expect(mock.snapshots.length).toBe(snapshotsBefore)

  mock.emit("ses_live", {
    event: {
      id: "evt_p3",
      type: "session.panel.updated",
      data: {
        sessionID: "ses_live",
        panel: "trades",
        key: "ETH-USD",
        data: [{ price: "2002.75", size: "2" }],
        provenance: { env: "hyperliquid-dev", source: "ws", timestamp: "2026-06-11T01:02:04.000Z", symbol: "ETH-USD" },
      },
    },
  })
  const updated = await active!.waitForFrame((current) => current.includes("2002.75"))
  expect(updated).not.toContain("2001.5")
  expect(mock.snapshots.length).toBe(snapshotsBefore)
})

test("degraded panels fall back to HTTP snapshot polling with an honest source label", async () => {
  const mock = createMockApi({ sessions: [makeSession({ id: "ses_degraded", title: "degraded session" })] })
  await openFirstSession(mock, "degraded session", "ses_degraded")

  await active!.mockInput.typeText("/book eth-usd")
  active!.mockInput.pressEnter()
  await active!.waitForFrame((current) => current.includes("book ETH-USD"))

  const requestsBefore = mock.gteRequests.filter((path) => path.includes("/book")).length
  mock.emit("ses_degraded", {
    event: {
      id: "evt_d1",
      type: "session.panel.status",
      data: {
        sessionID: "ses_degraded",
        panel: "book",
        key: "ETH-USD",
        status: "degraded",
        reason: "ws unavailable",
      },
    },
  })

  // The poller (40ms in tests) refreshes the panel over HTTP and the header
  // shows the snapshot-fallback source instead of pretending it is live.
  const frame = await active!.waitForFrame((current) => current.includes("snapshot (fallback)"))
  expect(frame).toContain("ws unavailable")
  await active!.waitFor(() => mock.gteRequests.filter((path) => path.includes("/book")).length > requestsBefore)
})

test("reopening a session restores panels from durable intent", async () => {
  const session = makeSession({
    id: "ses_restore",
    title: "restore session",
    selectedMarket: "ETH-USD",
    trackedAddress: "0x52908400098527886e0f7030069857d2e4169ee7",
    pinnedPanels: [{ panel: "book", key: "ETH-USD" }],
  } as never)
  const mock = createMockApi({ sessions: [session] })
  await openFirstSession(mock, "restore session", "ses_restore")

  const frame = await active!.waitForFrame((current) => current.includes("book ETH-USD"))
  expect(frame).toContain("market: ETH-USD")
  expect(frame).toContain("tracked address:")
  expect(frame).toContain("0x52908400098527886e0f7030069857d2e4169e") // wraps inside the panel
  expect(frame).toContain("connecting…")
})
