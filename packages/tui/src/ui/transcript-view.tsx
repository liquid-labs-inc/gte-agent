import { For, Show, Switch, Match } from "solid-js"
import type { SnapshotEntry, TranscriptEntry } from "../state/transcript"
import { theme } from "./theme"

function formatRow(row: Record<string, string | number | boolean | null>): string {
  return Object.entries(row)
    .map(([key, value]) => `${key}=${value === null ? "—" : String(value)}`)
    .join("  ")
}

/** Compact rendering of a durable data snapshot (no raw payloads). */
function SnapshotEntryView(props: { entry: SnapshotEntry }) {
  const header = () => {
    const parts = [props.entry.command]
    if (props.entry.key !== undefined) parts.push(props.entry.key)
    const provenance = props.entry.provenance
    const where = [provenance.source, provenance.env].filter((item) => item !== undefined).join(" · ")
    return `[data] ${parts.join(" ")}${where.length > 0 ? ` · ${where}` : ""}${provenance.timestamp ? ` · ${provenance.timestamp}` : ""}`
  }
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.info}>{header()}</text>
      <Show when={props.entry.summary.title}>
        <text fg={theme.text}>{props.entry.summary.title}</text>
      </Show>
      <Show when={props.entry.summary.fields}>
        <text fg={theme.text} wrapMode="word">
          {Object.entries(props.entry.summary.fields ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join("  ·  ")}
        </text>
      </Show>
      <For each={props.entry.summary.rows ?? []}>
        {(row) => (
          <text fg={theme.muted} wrapMode="word">
            {formatRow(row)}
          </text>
        )}
      </For>
      <Show when={props.entry.summary.note}>
        <text fg={theme.muted} wrapMode="word">
          {props.entry.summary.note}
        </text>
      </Show>
    </box>
  )
}

function AssistantEntry(props: { entry: Extract<TranscriptEntry, { kind: "assistant" }> }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.accent}>
        assistant{props.entry.status === "streaming" ? " …" : props.entry.status === "error" ? " ✗" : ""}
      </text>
      <For each={props.entry.parts}>
        {(part) => (
          <Switch>
            <Match when={part.type === "text"}>
              <text fg={theme.assistant} wrapMode="word">
                {part.text}
              </text>
            </Match>
            <Match when={part.type === "reasoning"}>
              <text fg={theme.muted} wrapMode="word">
                [reasoning] {part.text}
              </text>
            </Match>
            <Match when={part.type === "tool"}>
              <text fg={theme.info}>
                [tool] {part.toolName ?? part.id} {part.done ? "done" : "running…"}
              </text>
            </Match>
          </Switch>
        )}
      </For>
      <Show when={props.entry.error}>
        <text fg={theme.error} wrapMode="word">
          {props.entry.error}
        </text>
      </Show>
    </box>
  )
}

export function TranscriptView(props: { entries: readonly TranscriptEntry[]; loading: boolean }) {
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <Show when={!props.loading} fallback={<text fg={theme.muted}>loading history…</text>}>
        <Show when={props.entries.length > 0} fallback={<text fg={theme.muted}>no messages yet — type a prompt below</text>}>
          <For each={props.entries}>
            {(entry) => (
              <Switch>
                <Match when={entry.kind === "user"}>
                  <box flexDirection="column" marginBottom={1}>
                    <text fg={theme.user}>you</text>
                    <text fg={theme.text} wrapMode="word">
                      {(entry as Extract<TranscriptEntry, { kind: "user" }>).text}
                    </text>
                  </box>
                </Match>
                <Match when={entry.kind === "assistant"}>
                  <AssistantEntry entry={entry as Extract<TranscriptEntry, { kind: "assistant" }>} />
                </Match>
                <Match when={entry.kind === "info"}>
                  <text fg={theme.muted} wrapMode="word">
                    [info] {(entry as Extract<TranscriptEntry, { kind: "info" }>).text}
                  </text>
                </Match>
                <Match when={entry.kind === "snapshot"}>
                  <SnapshotEntryView entry={entry as SnapshotEntry} />
                </Match>
              </Switch>
            )}
          </For>
        </Show>
      </Show>
    </scrollbox>
  )
}
