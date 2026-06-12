import { For, Show } from "solid-js"
import type { CompletionItem } from "../state/autocomplete"
import { theme } from "./theme"

export const MAX_VISIBLE_COMPLETIONS = 6

/**
 * Dropdown anchored above the prompt input. Purely presentational: the
 * highlight, filtering, and key handling live in PromptInput so the input
 * keeps focus while the dropdown is open.
 */
export function PromptAutocomplete(props: { title: string; items: readonly CompletionItem[]; selected: number }) {
  const start = () => (props.selected < MAX_VISIBLE_COMPLETIONS ? 0 : props.selected - MAX_VISIBLE_COMPLETIONS + 1)
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={theme.border}
      title={props.title}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={props.items.slice(start(), start() + MAX_VISIBLE_COMPLETIONS)}>
        {(item, index) => (
          <text fg={start() + index() === props.selected ? theme.accent : theme.text}>
            {start() + index() === props.selected ? "▸ " : "  "}
            {item.label}
            {item.detail === undefined ? "" : `  ${item.detail}`}
          </text>
        )}
      </For>
      <Show when={props.items.length > MAX_VISIBLE_COMPLETIONS}>
        <text fg={theme.muted}>
          {props.selected + 1}/{props.items.length} · ↑↓ move · tab/enter accept · esc dismiss
        </text>
      </Show>
    </box>
  )
}
