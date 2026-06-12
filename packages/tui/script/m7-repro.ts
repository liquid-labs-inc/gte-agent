#!/usr/bin/env bun
/**
 * Headless Milestone 7 reproduction harness.
 *
 * Drives the same in-process server bridge the TUI uses, through the same
 * raw-fetch clients, to exercise: catalog list, no-model prompt error,
 * Anthropic API-key auth, model selection, a real streamed turn, and a
 * tool-calling turn. Run: ANTHROPIC_TEST_KEY=... bun run script/m7-repro.ts
 */
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createModelsApi } from "../src/api/models"
import { startServerBridge, VIRTUAL_ORIGIN } from "../src/server/bridge"

const key = process.env.ANTHROPIC_TEST_KEY
const stage = process.argv[2] ?? "all"

function log(label: string, value?: unknown) {
  if (value === undefined) console.log(`\n=== ${label} ===`)
  else console.log(`\n=== ${label} ===\n${JSON.stringify(value, null, 2)}`)
}

const bridge = await startServerBridge()
const baseUrl = VIRTUAL_ORIGIN
const fetcher = bridge.fetch
const api = createApi({ baseUrl, fetch: fetcher })
const models = createModelsApi({ baseUrl, fetch: fetcher })
const subscribe = createEventSubscriber({ baseUrl, fetch: fetcher })

async function watchTurn(sessionID: string, label: string, timeoutMs = 90_000): Promise<void> {
  log(`events: ${label}`)
  await new Promise<void>((resolve) => {
    let finished = false
    const stop = subscribe({
      sessionID,
      onEvent: (envelope) => {
        const type = envelope.event.type
        const data = envelope.event.data
        const summary = JSON.stringify(data)
        console.log(`[event] ${type} ${summary.length > 400 ? summary.slice(0, 400) + "…" : summary}`)
        if (type === "session.next.turn.finished" || type.endsWith("turn.failed") || type.endsWith("idle")) {
          if (!finished) {
            finished = true
            setTimeout(() => {
              stop()
              resolve()
            }, 500)
          }
        }
      },
      onError: (error) => {
        console.log(`[event-error] ${error.message}`)
        if (!finished) {
          finished = true
          stop()
          resolve()
        }
      },
    })
    setTimeout(() => {
      if (!finished) {
        finished = true
        console.log(`[timeout] ${label} did not finish within ${timeoutMs}ms`)
        stop()
        resolve()
      }
    }, timeoutMs)
  })
}

try {
  log("health", await api.health())

  log("catalog")
  const catalog = await models.list()
  console.log(JSON.stringify(catalog, null, 2).slice(0, 3000))

  log("auth status (before)", await models.authStatus())

  const session = await api.createSession({ directory: process.cwd() })
  // SDK branded ids generate as unknown (known limitation); stringify like the app does.
  const sessionID = String(session.id)
  log("session created", { id: sessionID })

  if (stage === "all" || stage === "no-model") {
    // 1. Prompt with no model configured: expect a visible error directing to /models.
    log("prompting with no model configured")
    const admitted = await api.prompt(sessionID, "hello with no model")
    console.log("admitted:", JSON.stringify(admitted))
    await watchTurn(sessionID, "no-model prompt", 30_000)
  }

  if (stage === "all" || stage === "real") {
    if (!key) throw new Error("ANTHROPIC_TEST_KEY not set")
    log("storing anthropic api key")
    console.log(JSON.stringify(await models.storeApiKey("anthropic", key)))

    log("auth status (after)", await models.authStatus())

    log("selecting anthropic/claude-fable-5")
    const selected = await models.select({
      providerID: "anthropic",
      modelID: "claude-fable-5",
      sessionID,
    })
    console.log(JSON.stringify(selected, null, 2))

    log("prompting for a real streamed reply")
    await api.prompt(sessionID, "Reply with exactly: M7 LIVE OK")
    await watchTurn(sessionID, "real turn")

    log("prompting for a tool-calling turn")
    await api.prompt(sessionID, "Use your gte tools to look up the current BTC market and summarize it in one sentence.")
    await watchTurn(sessionID, "tool turn", 120_000)

    log("final transcript")
    const messages = await api.messages(sessionID)
    for (const message of messages) {
      console.log(JSON.stringify(message).slice(0, 600))
    }
  }
} catch (error) {
  console.error("\n!!! REPRO FAILED:", error)
} finally {
  await bridge.shutdown()
  process.exit(0)
}
