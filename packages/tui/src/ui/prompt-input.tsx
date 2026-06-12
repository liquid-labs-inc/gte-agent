import type { InputRenderable, KeyEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SLASH_COMMANDS } from "../commands/slash"
import {
  acceptCompletion,
  completionRequest,
  filterCommands,
  filterItems,
  moveSelection,
  type CompletionItem,
  type CompletionRequest,
  type CompletionSources,
} from "../state/autocomplete"
import { PromptAutocomplete } from "./prompt-autocomplete"
import { theme } from "./theme"

export function PromptInput(props: {
  disabled?: boolean
  onSubmit: (text: string) => void
  /**
   * Arg-completion data providers (see createCompletionSources). Command-name
   * completion works without them; arg stages simply stay empty.
   */
  completionSources?: CompletionSources
}) {
  let ref: InputRenderable | undefined
  // Stale-guard for async arg-candidate fetches while typing refines the query.
  let argEpoch = 0
  const [state, setState] = createStore<{
    request?: CompletionRequest
    items: readonly CompletionItem[]
    selected: number
    dismissed: boolean
  }>({ items: [], selected: 0, dismissed: false })

  const open = () => !state.dismissed && state.request !== undefined && state.items.length > 0

  /** Re-derive the dropdown from the full input text (typing, accept, clear). */
  const refresh = (text: string) => {
    // Every input event invalidates in-flight arg fetches, even when the new
    // text leaves the arg stage entirely (e.g. backspacing "/book " back to
    // "/book" must not let the old symbol fetch overwrite the command list).
    const epoch = ++argEpoch
    const previous = state.request
    const request = completionRequest(text, SLASH_COMMANDS)
    setState({ request, selected: 0, dismissed: false })
    if (request === undefined) {
      setState("items", [])
      return
    }
    if (request.stage === "command") {
      setState("items", filterCommands(SLASH_COMMANDS, request.query))
      return
    }
    // Entering a different arg source drops the now-wrong candidates while the
    // fetch is in flight; refining within one source keeps the list stable.
    if (previous?.stage !== "arg" || previous.source !== request.source) setState("items", [])
    const provider = props.completionSources?.[request.source]
    if (provider === undefined) return
    provider(request.query)
      .then((items) => {
        if (epoch !== argEpoch) return
        const filtered = filterItems(items, request.query)
        // Clamp in case arrow navigation moved past the end of the (stale)
        // list while this fetch was in flight and the result is shorter.
        setState({ items: filtered, selected: Math.min(state.selected, Math.max(filtered.length - 1, 0)) })
      })
      .catch(() => {
        // Candidate fetch failed; the dropdown just stays empty.
        if (epoch === argEpoch) setState("items", [])
      })
  }

  const onKey = (event: KeyEvent) => {
    if (!open()) return
    const consume = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.name === "escape") {
      setState("dismissed", true)
      return consume()
    }
    if (event.name === "up" || event.name === "down") {
      setState("selected", moveSelection(state.items.length, state.selected, event.name === "down" ? 1 : -1))
      return consume()
    }
    if (event.name === "tab" || event.name === "return" || event.name === "kpenter" || event.name === "linefeed") {
      const item = state.items[state.selected]
      const current = ref?.value ?? ""
      const next =
        state.request === undefined || item === undefined ? current : acceptCompletion(current, state.request, item)
      if (next === current) {
        // Accepting changes nothing: let Enter fall through to submit the
        // prompt; Tab is still swallowed so it never reaches the input.
        if (event.name === "tab") consume()
        return
      }
      if (ref !== undefined) ref.value = next // emits "input", which re-derives the dropdown
      return consume()
    }
  }

  const renderer = useRenderer()
  onMount(() => {
    // Prepended so the dropdown wins over app-level handlers (Esc closes the
    // dropdown, not the session) and over the focused input renderable
    // (Enter accepts the highlighted item instead of submitting).
    renderer.keyInput.prependListener("keypress", onKey)
  })
  onCleanup(() => {
    renderer.keyInput.off("keypress", onKey)
  })

  const title = () => {
    if (state.request?.stage !== "arg") return "commands"
    return state.request.source === "symbol" ? "symbols" : "models"
  }

  return (
    <box flexShrink={0} flexDirection="column">
      <Show when={open()}>
        <PromptAutocomplete title={title()} items={state.items} selected={state.selected} />
      </Show>
      <box border borderColor={theme.border} title="prompt" paddingLeft={1} paddingRight={1}>
        <input
          focused
          placeholder="type a prompt and press enter"
          ref={(renderable: InputRenderable) => {
            ref = renderable
          }}
          onInput={refresh}
          onSubmit={() => {
            const text = (ref?.value ?? "").trim()
            if (text.length === 0 || props.disabled) return
            props.onSubmit(text)
            if (ref) ref.value = ""
          }}
        />
      </box>
    </box>
  )
}
