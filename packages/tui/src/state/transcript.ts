/**
 * Pure transcript model.
 *
 * The transcript is seeded from the session messages endpoint and then kept
 * current by applying canonical session events. All updates are keyed by
 * message/part IDs so replayed events upsert idempotently over seeded
 * history instead of duplicating entries.
 */
import type { SessionPublicMessage } from "../api/client"
import type { SessionEventEnvelope } from "../api/events"

export type TranscriptPart = {
  readonly id: string
  readonly type: "text" | "reasoning" | "tool"
  readonly text: string
  readonly done: boolean
  readonly toolName?: string
}

export type SnapshotEntry = {
  readonly kind: "snapshot"
  readonly id: string
  readonly command: string
  readonly panel?: string
  readonly key?: string
  readonly summary: {
    readonly title?: string
    readonly fields?: Record<string, string>
    readonly rows?: ReadonlyArray<Record<string, string | number | boolean | null>>
    readonly note?: string
  }
  readonly provenance: {
    readonly env?: string
    readonly source?: string
    readonly timestamp?: string
    readonly symbol?: string
    readonly address?: string
  }
}

export type TranscriptEntry =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant"
      readonly id: string
      readonly parts: readonly TranscriptPart[]
      readonly status: "streaming" | "done" | "error"
      readonly error?: string
    }
  | { readonly kind: "info"; readonly id: string; readonly text: string }
  | SnapshotEntry

export function seedFromMessages(messages: readonly SessionPublicMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const message of messages) {
    switch (message.type) {
      case "user":
        entries.push({ kind: "user", id: String(message.id), text: message.text })
        break
      case "assistant":
        entries.push({
          kind: "assistant",
          id: String(message.id),
          parts: message.content.map((part) =>
            part.type === "tool"
              ? { id: part.id, type: "tool" as const, text: "", done: true, toolName: part.name }
              : { id: part.id, type: part.type, text: part.text, done: true },
          ),
          status: message.error ? "error" : "done",
          error: message.error?.message,
        })
        break
      case "synthetic":
      case "system":
        entries.push({ kind: "info", id: String(message.id), text: message.text })
        break
      case "compaction":
        entries.push({ kind: "info", id: String(message.id), text: `[compaction] ${message.summary}` })
        break
      default:
        break
    }
  }
  return entries
}

function upsertUser(entries: readonly TranscriptEntry[], id: string, text: string): TranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.id === id)
  const entry: TranscriptEntry = { kind: "user", id, text }
  if (index < 0) return [...entries, entry]
  const next = [...entries]
  next[index] = entry
  return next
}

function updateAssistant(
  entries: readonly TranscriptEntry[],
  id: string,
  update: (current: Extract<TranscriptEntry, { kind: "assistant" }>) => TranscriptEntry,
): TranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.id === id && entry.kind === "assistant")
  if (index < 0) {
    const created = update({ kind: "assistant", id, parts: [], status: "streaming" })
    return [...entries, created]
  }
  const next = [...entries]
  next[index] = update(entries[index] as Extract<TranscriptEntry, { kind: "assistant" }>)
  return next
}

function upsertPart(
  parts: readonly TranscriptPart[],
  id: string,
  update: (current: TranscriptPart) => TranscriptPart,
  create: () => TranscriptPart,
): TranscriptPart[] {
  const index = parts.findIndex((part) => part.id === id)
  if (index < 0) return [...parts, create()]
  const next = [...parts]
  next[index] = update(parts[index])
  return next
}

export function applyEvent(entries: readonly TranscriptEntry[], envelope: SessionEventEnvelope): TranscriptEntry[] {
  const { type, data } = envelope.event
  const str = (key: string) => {
    const value = data[key]
    return typeof value === "string" ? value : String(value ?? "")
  }

  switch (type) {
    case "session.next.prompted":
    case "session.next.prompt.admitted":
    case "session.next.prompt.promoted": {
      const prompt = data["prompt"] as { text?: unknown } | undefined
      const text = typeof prompt?.text === "string" ? prompt.text : ""
      return upsertUser(entries, str("messageID"), text)
    }
    case "session.next.step.started":
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        status: "streaming",
      }))
    case "session.next.text.started":
    case "session.next.reasoning.started": {
      const partID = type.includes("reasoning") ? str("reasoningID") : str("textID")
      const partType = type.includes("reasoning") ? ("reasoning" as const) : ("text" as const)
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        parts: upsertPart(
          current.parts,
          partID,
          (part) => part,
          () => ({ id: partID, type: partType, text: "", done: false }),
        ),
      }))
    }
    case "session.next.text.delta":
    case "session.next.reasoning.delta": {
      const partID = type.includes("reasoning") ? str("reasoningID") : str("textID")
      const partType = type.includes("reasoning") ? ("reasoning" as const) : ("text" as const)
      const delta = str("delta")
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        parts: upsertPart(
          current.parts,
          partID,
          (part) => ({ ...part, text: part.text + delta }),
          () => ({ id: partID, type: partType, text: delta, done: false }),
        ),
      }))
    }
    case "session.next.text.ended":
    case "session.next.reasoning.ended": {
      const partID = type.includes("reasoning") ? str("reasoningID") : str("textID")
      const partType = type.includes("reasoning") ? ("reasoning" as const) : ("text" as const)
      const text = str("text")
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        parts: upsertPart(
          current.parts,
          partID,
          (part) => ({ ...part, text, done: true }),
          () => ({ id: partID, type: partType, text, done: true }),
        ),
      }))
    }
    case "session.next.tool.called": {
      const callID = str("callID")
      const tool = str("tool")
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        parts: upsertPart(
          current.parts,
          callID,
          (part) => ({ ...part, toolName: tool }),
          () => ({ id: callID, type: "tool", text: "", done: false, toolName: tool }),
        ),
      }))
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const callID = str("callID")
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        parts: upsertPart(
          current.parts,
          callID,
          (part) => ({ ...part, done: true }),
          () => ({ id: callID, type: "tool", text: "", done: true }),
        ),
      }))
    }
    case "session.next.step.ended":
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        status: "done",
      }))
    case "session.next.step.failed": {
      const error = data["error"] as { message?: unknown } | undefined
      return updateAssistant(entries, str("assistantMessageID"), (current) => ({
        ...current,
        status: "error",
        error: typeof error?.message === "string" ? error.message : "Step failed",
      }))
    }
    case "session.snapshot.recorded": {
      // Durable compact data snapshot; keyed by the event id so replay upserts.
      const id = envelope.event.id
      const summary = (data["summary"] ?? {}) as SnapshotEntry["summary"]
      const provenance = (data["provenance"] ?? {}) as SnapshotEntry["provenance"]
      const entry: SnapshotEntry = {
        kind: "snapshot",
        id,
        command: str("command"),
        panel: typeof data["panel"] === "string" ? data["panel"] : undefined,
        key: typeof data["key"] === "string" ? data["key"] : undefined,
        summary,
        provenance,
      }
      const index = entries.findIndex((existing) => existing.id === id)
      if (index < 0) return [...entries, entry]
      const next = [...entries]
      next[index] = entry
      return next
    }
    case "session.next.synthetic":
    case "session.next.context.updated": {
      const id = str("messageID")
      const text = str("text")
      const index = entries.findIndex((entry) => entry.id === id)
      const entry: TranscriptEntry = { kind: "info", id, text }
      if (index < 0) return [...entries, entry]
      const next = [...entries]
      next[index] = entry
      return next
    }
    default:
      return [...entries]
  }
}

/** True while any assistant entry is still streaming. */
export function isStreaming(entries: readonly TranscriptEntry[]): boolean {
  return entries.some((entry) => entry.kind === "assistant" && entry.status === "streaming")
}
