import { Show } from "solid-js"
import { theme } from "./theme"

export function ErrorBanner(props: { message?: string }) {
  return (
    <Show when={props.message}>
      <box flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor="#3d2230">
        <text fg={theme.error} wrapMode="word">
          error: {props.message}
        </text>
      </box>
    </Show>
  )
}
