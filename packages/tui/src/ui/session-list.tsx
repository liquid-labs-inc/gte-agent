import { createMemo, Show } from "solid-js"
import type { SessionInfo } from "../api/client"
import { theme } from "./theme"

const NEW_SESSION = "__new__"

export function SessionList(props: {
  sessions: readonly SessionInfo[]
  loading: boolean
  onOpen: (session: SessionInfo) => void
  onCreate: () => void
}) {
  const options = createMemo(() => [
    { name: "+ new session", description: "create a session on the demo runner", value: NEW_SESSION },
    ...props.sessions.map((session) => ({
      name: session.title || String(session.id),
      description: `${String(session.id)} · ${new Date(session.time.updated).toLocaleString()}`,
      value: String(session.id),
    })),
  ])

  return (
    <box flexDirection="column" flexGrow={1} border borderColor={theme.border} title="sessions" padding={1}>
      <Show when={!props.loading} fallback={<text fg={theme.muted}>loading sessions…</text>}>
        <select
          focused
          flexGrow={1}
          options={options()}
          onSelect={(_index, option) => {
            if (!option) return
            if (option.value === NEW_SESSION) {
              props.onCreate()
              return
            }
            const session = props.sessions.find((item) => String(item.id) === option.value)
            if (session) props.onOpen(session)
          }}
        />
        <text fg={theme.muted}>enter open · ctrl+n new · ctrl+c quit</text>
      </Show>
    </box>
  )
}
