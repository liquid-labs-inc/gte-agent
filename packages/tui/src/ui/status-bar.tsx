import { Show } from "solid-js"
import type { AuthStatus } from "../api/auth"
import { formatAuthStatus } from "../api/auth"
import type { SessionInfo } from "../api/client"
import type { ModelRef } from "../api/models"
import { theme } from "./theme"

export type ServerStatus = {
  readonly mode: "in-process" | "listening"
  readonly url: string
}

/**
 * Active model for the status line: the session's own selection wins, new
 * sessions inherit the global default, and with neither set the line points
 * at /models (matching the runner's strict no-silent-fallback resolution).
 */
export function formatActiveModel(session: SessionInfo | undefined, defaultModel: ModelRef | undefined): string {
  const model = session?.model
  if (model !== undefined && model !== null) return `model ${model.providerID}/${model.id}`
  if (defaultModel !== undefined) return `model ${defaultModel.providerID}/${defaultModel.id} (default)`
  return "model not set — /models"
}

export function StatusBar(props: {
  server: ServerStatus
  auth: AuthStatus
  session?: SessionInfo
  /** Global default model (inherited by sessions without their own selection). */
  defaultModel?: ModelRef
  streaming?: boolean
}) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["top"]}
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row">
        <text fg={theme.ok}>server up</text>
        <text fg={theme.muted}>
          {" "}
          · {props.server.mode === "in-process" ? "in-process worker" : "listening"} {props.server.url}
        </text>
      </box>
      <text fg={theme.muted}>{formatAuthStatus(props.auth)}</text>
      <Show when={props.session} fallback={<text fg={theme.muted}>no session selected</text>}>
        {(session) => (
          <text fg={theme.muted}>
            session {String(session().id)} · {props.streaming ? "streaming" : "idle"} ·{" "}
            {formatActiveModel(session(), props.defaultModel)} · principal {session().principalID} · authority{" "}
            {session().authorityID}
          </text>
        )}
      </Show>
    </box>
  )
}
