import type { InputRenderable } from "@opentui/core"
import { theme } from "./theme"

export function PromptInput(props: { disabled?: boolean; onSubmit: (text: string) => void }) {
  let ref: InputRenderable | undefined

  return (
    <box flexShrink={0} border borderColor={theme.border} title="prompt" paddingLeft={1} paddingRight={1}>
      <input
        focused
        placeholder="type a prompt and press enter"
        ref={(renderable: InputRenderable) => {
          ref = renderable
        }}
        onSubmit={() => {
          const text = (ref?.value ?? "").trim()
          if (text.length === 0 || props.disabled) return
          props.onSubmit(text)
          if (ref) ref.value = ""
        }}
      />
    </box>
  )
}
