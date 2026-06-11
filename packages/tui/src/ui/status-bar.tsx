import { Show } from "solid-js"
import type { AuthStatus } from "../api/auth"
import { formatAuthStatus } from "../api/auth"
import type { SessionInfo } from "../api/client"
import { theme } from "./theme"

export type ServerStatus = {
  readonly mode: "in-process" | "listening"
  readonly url: string
}

export function StatusBar(props: {
  server: ServerStatus
  auth: AuthStatus
  session?: SessionInfo
  streaming?: boolean
}) {
  return (
    <box flexDirection="column" flexShrink={0} border={["top"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={theme.ok}>server up</text>
        <text fg={theme.muted}>
          {" "}
          · {props.server.mode === "in-process" ? "in-process worker" : "listening"} {props.server.url}
        </text>
      </box>
      <text fg={theme.muted}>{formatAuthStatus(props.auth)}</text>
      <Show
        when={props.session}
        fallback={<text fg={theme.muted}>no session selected</text>}
      >
        {(session) => (
          <text fg={theme.muted}>
            session {String(session().id)} · {props.streaming ? "streaming" : "idle"} · principal{" "}
            {session().principalID} · authority {session().authorityID}
          </text>
        )}
      </Show>
    </box>
  )
}
