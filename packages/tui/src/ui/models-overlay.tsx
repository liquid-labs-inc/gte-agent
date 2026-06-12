import type { KeyEvent, PasteEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import type { ModelRef, ModelsApi, ModelsCatalog } from "../api/models"
import { moveSelection } from "../state/autocomplete"
import {
  authMethods,
  backStep,
  modelRefString,
  pickerEntries,
  selectableEntries,
  type ModelTarget,
  type WizardStep,
} from "../state/models"
import { theme } from "./theme"

const CURSOR = "▏"

/**
 * The /models modal overlay and provider auth wizard (Milestone 7).
 *
 * Rendered in place of the prompt input (which unmounts while the overlay is
 * open, so its key handlers and focus go away); a prepended keypress listener
 * makes the overlay modal — it consumes every key except Ctrl+C.
 *
 * Flow: picker (fuzzy filter, grouped by provider, auth status per row) →
 * selecting an authed model applies it (session + global default; the durable
 * model-switched event confirms in the transcript) → selecting an unauthed
 * model chains into the wizard: method picker → masked paste input or OAuth
 * progress view (authorize URL, waiting for the browser callback, first-class
 * paste-redirect fallback) → confirmation. Esc backs out exactly one step.
 *
 * SECURITY: the pasted credential lives only in component state and the
 * api-key request body. It is rendered exclusively as mask characters and is
 * cleared from state on submit/back; nothing here logs or persists it.
 */
export function ModelsOverlay(props: {
  models: ModelsApi
  sessionID: string
  /** The session's current model selection (marks the picker row). */
  current?: ModelRef
  /** Direct `/models <provider>/<model>` target — skips the picker. */
  target?: ModelTarget
  onClose: () => void
  /** Selection applied (session + global default persisted server-side). */
  onApplied: (model: ModelRef, name: string) => void
}) {
  const [state, setState] = createStore<{
    loading: boolean
    catalog?: ModelsCatalog
    step: WizardStep
    filter: string
    selected: number
    /** Masked paste buffer; never rendered, cleared on submit/back. */
    secret: string
    redirect: string
    oauth?: { flow: string; url: string; listening: boolean; waiting: boolean }
    busy: boolean
    error?: string
  }>({ loading: true, step: { kind: "picker" }, filter: "", selected: 0, secret: "", redirect: "", busy: false })

  // How the overlay was entered decides where the method picker backs out to.
  // A direct target that turns out unknown falls back to the picker.
  let entry: "picker" | "direct" = props.target === undefined ? "picker" : "direct"
  // Bumped on every back/close so in-flight requests (select, key store,
  // OAuth start and long-poll completion) cannot land on a different step.
  let epoch = 0
  let disposed = false
  const guard = (captured: number, apply: () => void) => {
    if (!disposed && captured === epoch) apply()
  }

  const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

  const entries = createMemo(() => {
    if (state.catalog === undefined) return []
    return pickerEntries(state.catalog.providers, { current: props.current, filter: state.filter })
  })
  const selectable = createMemo(() => selectableEntries(entries()))
  const highlighted = () => selectable()[state.selected]
  /** Wizard target for the method/paste/oauth steps. */
  const stepTarget = () => {
    const step = state.step
    return step.kind === "method" || step.kind === "paste" || step.kind === "oauth" ? step.target : undefined
  }

  const apply = (target: ModelTarget) => {
    const captured = epoch
    setState({ busy: true, error: undefined })
    props.models
      .select({ providerID: target.providerID, modelID: target.modelID, sessionID: props.sessionID })
      .then((result) =>
        guard(captured, () => {
          props.onApplied(result.model, result.name)
          setState({
            busy: false,
            step: {
              kind: "confirm",
              message: `Model set to ${modelRefString(result.model)} (${result.name}) — session and global default updated.`,
            },
          })
        }),
      )
      .catch((error: unknown) => guard(captured, () => setState({ busy: false, error: describe(error) })))
  }

  const submitPaste = (target: ModelTarget) => {
    const secret = state.secret.trim()
    if (secret.length === 0) return setState("error", "Paste a credential first.")
    const captured = epoch
    // Clear the buffer immediately; on failure the user pastes again.
    setState({ busy: true, error: undefined, secret: "" })
    props.models
      .storeApiKey(target.providerID, secret)
      .then(() => guard(captured, () => apply(target)))
      .catch((error: unknown) => guard(captured, () => setState({ busy: false, error: describe(error) })))
  }

  const startOauth = (target: ModelTarget) => {
    const captured = epoch
    setState({ busy: true, error: undefined, redirect: "", oauth: undefined })
    props.models
      .oauthStart(target.providerID)
      .then((start) =>
        guard(captured, () => {
          setState({
            busy: false,
            oauth: {
              flow: start.flow,
              url: start.url,
              listening: start.callback.listening,
              waiting: start.callback.listening,
            },
          })
          if (!start.callback.listening) return
          // Long-poll the localhost callback; a pasted redirect or Esc bumps
          // the epoch so a late resolution is dropped.
          props.models
            .oauthComplete(target.providerID, start.flow)
            .then(() => guard(captured, () => apply(target)))
            .catch((error: unknown) =>
              guard(captured, () =>
                setState({
                  oauth: state.oauth === undefined ? undefined : { ...state.oauth, waiting: false },
                  error: `${describe(error)} — paste the redirect URL below to finish.`,
                }),
              ),
            )
        }),
      )
      .catch((error: unknown) =>
        guard(captured, () => setState({ busy: false, error: describe(error), step: { kind: "method", target } })),
      )
  }

  const submitRedirect = (target: ModelTarget) => {
    const oauth = state.oauth
    if (oauth === undefined) return
    const redirect = state.redirect.trim()
    if (redirect.length === 0) return setState("error", "Paste the redirect URL first.")
    // Invalidate the waiting long-poll: the pasted redirect wins.
    const captured = ++epoch
    setState({ busy: true, error: undefined })
    props.models
      .oauthComplete(target.providerID, oauth.flow, redirect)
      .then(() =>
        guard(captured, () => {
          setState("redirect", "")
          apply(target)
        }),
      )
      .catch((error: unknown) => guard(captured, () => setState({ busy: false, error: describe(error) })))
  }

  const beginTarget = (catalog: ModelsCatalog, target: ModelTarget) => {
    const provider = catalog.providers.find((candidate) => candidate.id === target.providerID)
    const model = provider?.models.find((candidate) => candidate.id === target.modelID)
    if (provider === undefined || model === undefined) {
      entry = "picker"
      setState("error", `Unknown model "${target.providerID}/${target.modelID}" — pick one from the catalog.`)
      return
    }
    if (provider.auth.authenticated) return apply(target)
    setState({ step: { kind: "method", target }, selected: 0 })
  }

  const back = () => {
    epoch++
    const next = backStep(state.step, entry)
    if (next === undefined) return props.onClose()
    setState({ step: next, error: undefined, secret: "", redirect: "", oauth: undefined, selected: 0, busy: false })
  }

  const accept = () => {
    const step = state.step
    if (step.kind === "confirm") return props.onClose()
    if (state.busy) return
    if (step.kind === "picker") {
      const row = highlighted()
      if (row === undefined) return
      const target = { providerID: row.providerID, modelID: row.modelID }
      if (row.authed) return apply(target)
      setState({ step: { kind: "method", target }, selected: 0, error: undefined })
      return
    }
    if (step.kind === "method") {
      const option = authMethods(step.target.providerID)[state.selected]
      if (option === undefined) return
      if (option.id === "paste") {
        setState({ step: { kind: "paste", target: step.target }, secret: "", error: undefined })
        return
      }
      setState({ step: { kind: "oauth", target: step.target }, error: undefined })
      startOauth(step.target)
      return
    }
    if (step.kind === "paste") return submitPaste(step.target)
    submitRedirect(step.target)
  }

  const printable = (event: KeyEvent) => {
    if (event.ctrl || event.meta) return undefined
    const sequence = event.sequence
    if (typeof sequence !== "string" || sequence.length !== 1) return undefined
    if (sequence < " " || sequence === "\x7f") return undefined
    return sequence
  }

  const appendText = (text: string) => {
    if (text.length === 0) return
    const step = state.step
    if (step.kind === "picker") return setState({ filter: state.filter + text, selected: 0 })
    if (step.kind === "paste") return setState("secret", state.secret + text)
    if (step.kind === "oauth") return setState("redirect", state.redirect + text)
  }

  const onKey = (event: KeyEvent) => {
    // Ctrl+C still exits the app; everything else belongs to the modal.
    if (event.ctrl && event.name === "c") return
    event.preventDefault()
    event.stopPropagation()
    if (event.name === "escape") return back()
    if (event.name === "return" || event.name === "kpenter" || event.name === "linefeed") return accept()
    if (state.busy) return
    const step = state.step
    if ((step.kind === "picker" || step.kind === "method") && (event.name === "up" || event.name === "down")) {
      const count = step.kind === "picker" ? selectable().length : authMethods(step.target.providerID).length
      setState("selected", moveSelection(count, state.selected, event.name === "down" ? 1 : -1))
      return
    }
    if (event.name === "backspace") {
      if (step.kind === "picker") return setState({ filter: state.filter.slice(0, -1), selected: 0 })
      if (step.kind === "paste") return setState("secret", state.secret.slice(0, -1))
      if (step.kind === "oauth") return setState("redirect", state.redirect.slice(0, -1))
      return
    }
    const char = printable(event)
    if (char !== undefined) appendText(char)
  }

  const onPaste = (event: PasteEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (state.busy) return
    appendText(new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""))
  }

  const renderer = useRenderer()
  onMount(() => {
    // Prepended so the overlay wins over app-level handlers (Esc backs out a
    // wizard step instead of closing the session) — same pattern as the
    // prompt autocomplete dropdown.
    renderer.keyInput.prependListener("keypress", onKey)
    renderer.keyInput.prependListener("paste", onPaste)
    const captured = epoch
    props.models
      .list(props.sessionID)
      .then((catalog) =>
        guard(captured, () => {
          setState({ catalog, loading: false })
          if (props.target !== undefined) beginTarget(catalog, props.target)
        }),
      )
      .catch((error: unknown) => guard(captured, () => setState({ loading: false, error: describe(error) })))
  })
  onCleanup(() => {
    disposed = true
    renderer.keyInput.off("keypress", onKey)
    renderer.keyInput.off("paste", onPaste)
  })

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={theme.accent}
      title="/models"
      paddingLeft={1}
      paddingRight={1}
    >
      <Show when={state.error}>
        <text fg={theme.error}>{state.error}</text>
      </Show>
      <Switch>
        <Match when={state.loading}>
          <text fg={theme.muted}>loading model catalog…</text>
        </Match>
        <Match when={state.step.kind === "picker"}>
          <text fg={theme.text}>
            filter: {state.filter}
            {CURSOR}
          </text>
          <Show when={selectable().length === 0}>
            <text fg={theme.muted}>no models match "{state.filter}"</text>
          </Show>
          <For each={entries()}>
            {(row) =>
              row.kind === "header" ? (
                <text fg={theme.muted}>{row.label}</text>
              ) : (
                <text fg={highlighted()?.ref === row.ref ? theme.accent : theme.text}>
                  {highlighted()?.ref === row.ref ? "▸ " : "  "}
                  {row.ref}
                  {row.isCurrent ? " ← current" : row.isDefault ? " (default)" : ""}
                  {"  "}
                  {row.authed ? "· authed" : "· needs setup"}
                </text>
              )
            }
          </For>
          <text fg={theme.muted}>type to filter · ↑↓ move · enter select · esc close</text>
        </Match>
        <Match when={state.step.kind === "method"}>
          <text fg={theme.text}>{stepTarget()?.providerID} needs setup — choose a method:</text>
          <For each={authMethods(stepTarget()?.providerID ?? "")}>
            {(option, index) => (
              <text fg={index() === state.selected ? theme.accent : theme.text}>
                {index() === state.selected ? "▸ " : "  "}
                {option.label}
              </text>
            )}
          </For>
          <text fg={theme.muted}>↑↓ move · enter choose · esc back</text>
        </Match>
        <Match when={state.step.kind === "paste"}>
          <text fg={theme.text}>
            Paste {stepTarget()?.providerID === "anthropic" ? "an Anthropic API key or setup-token" : "an API key"} for{" "}
            {stepTarget()?.providerID}:
          </text>
          <text fg={theme.accent}>
            {"•".repeat(state.secret.length)}
            {CURSOR}
          </text>
          <text fg={theme.muted}>input is masked and never shown · enter store · esc back</text>
        </Match>
        <Match when={state.step.kind === "oauth"}>
          <text fg={theme.text}>Sign in with ChatGPT — open this URL in your browser:</text>
          <text fg={theme.accent}>{state.oauth?.url ?? "starting sign-in…"}</text>
          <Show when={state.oauth?.waiting}>
            <text fg={theme.info}>waiting for browser…</text>
          </Show>
          <Show when={state.oauth !== undefined && !state.oauth.listening}>
            <text fg={theme.muted}>callback port unavailable — finish by pasting the redirect URL</text>
          </Show>
          <text fg={theme.text}>
            redirect URL: {state.redirect}
            {CURSOR}
          </text>
          <text fg={theme.muted}>paste the redirect URL + enter to finish manually · esc back</text>
        </Match>
        <Match when={state.step.kind === "confirm"}>
          <text fg={theme.ok}>✓ {state.step.kind === "confirm" ? state.step.message : ""}</text>
          <text fg={theme.muted}>enter or esc to close</text>
        </Match>
      </Switch>
      <Show when={state.busy}>
        <text fg={theme.muted}>working…</text>
      </Show>
    </box>
  )
}
