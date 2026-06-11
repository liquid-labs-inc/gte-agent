import { describe, expect, test } from "bun:test"
import type { SessionPublicMessage } from "../src/api/client"
import type { SessionEventEnvelope } from "../src/api/events"
import { applyEvent, isStreaming, seedFromMessages, type TranscriptEntry } from "../src/state/transcript"

type AssistantEntry = Extract<TranscriptEntry, { kind: "assistant" }>

let cursor = 0
function envelope(type: string, data: Record<string, unknown>): SessionEventEnvelope {
  cursor++
  return { cursor, event: { id: `evt_${cursor}`, type, data } }
}

const userMessage: SessionPublicMessage = {
  id: "msg_user",
  type: "user",
  text: "hello",
  time: { created: 1 },
}

const assistantMessage: SessionPublicMessage = {
  id: "msg_assistant",
  type: "assistant",
  agent: "default",
  model: { id: "gte-agent-demo", providerID: "gte-agent-demo" },
  content: [{ type: "text", id: "text_1", text: "GTE Agent demo response." }],
  time: { created: 2 },
}

describe("seedFromMessages", () => {
  test("maps user and assistant history", () => {
    const entries = seedFromMessages([userMessage, assistantMessage])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ kind: "user", id: "msg_user", text: "hello" })
    expect(entries[1].kind).toBe("assistant")
    const assistant = entries[1] as Extract<(typeof entries)[number], { kind: "assistant" }>
    expect(assistant.status).toBe("done")
    expect(assistant.parts[0].text).toBe("GTE Agent demo response.")
  })
})

describe("applyEvent", () => {
  test("streams a full prompt/step/text lifecycle", () => {
    let entries = seedFromMessages([])
    entries = applyEvent(
      entries,
      envelope("session.next.prompt.admitted", { messageID: "msg_u1", prompt: { text: "hi" } }),
    )
    expect(entries).toEqual([{ kind: "user", id: "msg_u1", text: "hi" }])

    entries = applyEvent(entries, envelope("session.next.step.started", { assistantMessageID: "msg_a1" }))
    expect(isStreaming(entries)).toBe(true)

    entries = applyEvent(
      entries,
      envelope("session.next.text.started", { assistantMessageID: "msg_a1", textID: "t1" }),
    )
    entries = applyEvent(
      entries,
      envelope("session.next.text.delta", { assistantMessageID: "msg_a1", textID: "t1", delta: "GTE Agent " }),
    )
    entries = applyEvent(
      entries,
      envelope("session.next.text.delta", { assistantMessageID: "msg_a1", textID: "t1", delta: "demo response." }),
    )
    const streamingAssistant = entries.find((entry) => entry.id === "msg_a1")
    expect(streamingAssistant?.kind).toBe("assistant")
    expect((streamingAssistant as AssistantEntry).parts[0].text).toBe("GTE Agent demo response.")

    entries = applyEvent(
      entries,
      envelope("session.next.text.ended", {
        assistantMessageID: "msg_a1",
        textID: "t1",
        text: "GTE Agent demo response.",
      }),
    )
    entries = applyEvent(entries, envelope("session.next.step.ended", { assistantMessageID: "msg_a1" }))

    expect(isStreaming(entries)).toBe(false)
    const assistant = entries.find((entry) => entry.id === "msg_a1") as AssistantEntry
    expect(assistant.status).toBe("done")
    expect(assistant.parts).toHaveLength(1)
    expect(assistant.parts[0].done).toBe(true)
  })

  test("replay over seeded history upserts instead of duplicating", () => {
    let entries = seedFromMessages([userMessage, assistantMessage])
    entries = applyEvent(
      entries,
      envelope("session.next.prompt.admitted", { messageID: "msg_user", prompt: { text: "hello" } }),
    )
    entries = applyEvent(entries, envelope("session.next.step.started", { assistantMessageID: "msg_assistant" }))
    entries = applyEvent(
      entries,
      envelope("session.next.text.ended", {
        assistantMessageID: "msg_assistant",
        textID: "text_1",
        text: "GTE Agent demo response.",
      }),
    )
    entries = applyEvent(entries, envelope("session.next.step.ended", { assistantMessageID: "msg_assistant" }))

    expect(entries).toHaveLength(2)
    const assistant = entries[1] as AssistantEntry
    expect(assistant.status).toBe("done")
    expect(assistant.parts).toHaveLength(1)
    expect(assistant.parts[0].text).toBe("GTE Agent demo response.")
  })

  test("step failure surfaces an error state", () => {
    let entries = seedFromMessages([])
    entries = applyEvent(entries, envelope("session.next.step.started", { assistantMessageID: "msg_a2" }))
    entries = applyEvent(
      entries,
      envelope("session.next.step.failed", {
        assistantMessageID: "msg_a2",
        error: { type: "unknown", message: "provider exploded" },
      }),
    )
    const assistant = entries[0] as AssistantEntry
    expect(assistant.status).toBe("error")
    expect(assistant.error).toBe("provider exploded")
  })

  test("unknown event types are ignored", () => {
    const seeded = seedFromMessages([userMessage])
    const next = applyEvent(seeded, envelope("session.intent.updated", { sessionID: "ses_x" }))
    expect(next).toEqual(seeded)
  })

  test("snapshot events render compactly and replay idempotently by event id", () => {
    const data = {
      sessionID: "ses_x",
      command: "/book",
      panel: "book",
      key: "ETH-USD",
      summary: { title: "ETH-USD book", fields: { mid: "2000.5" }, rows: [{ side: "bid", price: "2000.4" }] },
      provenance: { env: "hyperliquid-dev", source: "http", timestamp: "2026-06-11T00:00:00.000Z", symbol: "ETH-USD" },
    }
    const first = envelope("session.snapshot.recorded", data)
    let entries = applyEvent(seedFromMessages([userMessage]), first)
    expect(entries).toHaveLength(2)
    const snapshot = entries[1] as Extract<TranscriptEntry, { kind: "snapshot" }>
    expect(snapshot.kind).toBe("snapshot")
    expect(snapshot.command).toBe("/book")
    expect(snapshot.key).toBe("ETH-USD")
    expect(snapshot.summary.fields?.mid).toBe("2000.5")
    expect(snapshot.provenance.source).toBe("http")

    // Replaying the same event (same id) upserts instead of duplicating.
    entries = applyEvent(entries, { cursor: first.cursor, event: first.event })
    expect(entries).toHaveLength(2)
  })

  test("ephemeral panel events without cursors do not grow the transcript", () => {
    const seeded = seedFromMessages([userMessage])
    const next = applyEvent(seeded, {
      event: {
        id: "evt_panel",
        type: "session.panel.updated",
        data: { sessionID: "ses_x", panel: "book", key: "ETH-USD", data: {} },
      },
    })
    expect(next).toEqual(seeded)
  })
})
