/**
 * Pure state for the /models overlay and provider auth wizard (Milestone 7).
 *
 * Everything stateful lives in the overlay component; this module owns the
 * derivations and transitions so they stay unit-testable: catalog rows grouped
 * by provider (`pickerEntries`, fuzzy-filtered), auth-method options per
 * provider (`authMethods`), the wizard step machine (`backStep` — Esc backs
 * out exactly one step), and ref parsing for `/models <provider>/<model>`.
 */
import fuzzysort from "fuzzysort"
import type { CatalogProvider, ModelRef, ModelsAuthStatus } from "../api/models"

export type ModelTarget = { readonly providerID: string; readonly modelID: string }

/** "anthropic/claude-fable-5" → target; undefined for anything not provider/model shaped. */
export function parseModelTarget(arg: string): ModelTarget | undefined {
  const separator = arg.indexOf("/")
  if (separator <= 0 || separator >= arg.length - 1 || arg.indexOf("/", separator + 1) !== -1) return undefined
  return { providerID: arg.slice(0, separator).toLowerCase(), modelID: arg.slice(separator + 1) }
}

export const modelRefString = (ref: ModelRef): string => `${ref.providerID}/${ref.id}`

export const authLabel = (auth: ModelsAuthStatus): string => {
  if (!auth.authenticated) return "needs setup"
  const method = auth.method === "oauth" ? "oauth" : "api key"
  return auth.source === undefined ? `authed (${method})` : `authed (${method} via ${auth.source})`
}

export type PickerEntry =
  | { readonly kind: "header"; readonly providerID: string; readonly label: string }
  | {
      readonly kind: "model"
      readonly providerID: string
      readonly modelID: string
      readonly ref: string
      readonly name: string
      readonly authed: boolean
      readonly isCurrent: boolean
      readonly isDefault: boolean
    }

/**
 * Render rows for the picker: models grouped under provider headers (catalog
 * order preserved), fuzzy-filtered over the `provider/model` ref when a filter
 * is set. Providers whose models are all filtered out drop their header.
 */
export function pickerEntries(
  providers: readonly CatalogProvider[],
  options?: { readonly current?: ModelRef; readonly filter?: string },
): readonly PickerEntry[] {
  const filter = options?.filter ?? ""
  return providers.flatMap((provider) => {
    const rows = provider.models.map(
      (model): Extract<PickerEntry, { kind: "model" }> => ({
        kind: "model",
        providerID: provider.id,
        modelID: model.id,
        ref: `${provider.id}/${model.id}`,
        name: model.name,
        authed: provider.auth.authenticated,
        isCurrent: options?.current !== undefined && modelRefString(options.current) === `${provider.id}/${model.id}`,
        isDefault: model.isDefault,
      }),
    )
    const kept = filter.length === 0 ? rows : fuzzysort.go(filter, rows, { key: "ref" }).map((result) => result.obj)
    if (kept.length === 0) return []
    return [
      { kind: "header", providerID: provider.id, label: `${provider.name} — ${authLabel(provider.auth)}` },
      ...kept,
    ]
  })
}

/** Selectable (model) rows in render order; the highlight indexes into this list. */
export const selectableEntries = (entries: readonly PickerEntry[]) =>
  entries.filter((entry): entry is Extract<PickerEntry, { kind: "model" }> => entry.kind === "model")

export type AuthMethodOption = { readonly id: "paste" | "oauth"; readonly label: string }

/**
 * Provider auth methods for the wizard method picker. Anthropic accepts a
 * pasted API key or setup-token through the same paste flow (the server
 * classifies the credential); only OpenAI offers ChatGPT sign-in.
 */
export function authMethods(providerID: string): readonly AuthMethodOption[] {
  if (providerID === "anthropic") return [{ id: "paste", label: "Paste API key or setup-token" }]
  if (providerID === "openai") {
    return [
      { id: "paste", label: "Paste API key" },
      { id: "oauth", label: "Sign in with ChatGPT" },
    ]
  }
  return [{ id: "paste", label: "Paste API key" }]
}

export type WizardStep =
  | { readonly kind: "picker" }
  | { readonly kind: "method"; readonly target: ModelTarget }
  | { readonly kind: "paste"; readonly target: ModelTarget }
  | { readonly kind: "oauth"; readonly target: ModelTarget }
  | { readonly kind: "confirm"; readonly message: string }

/**
 * Esc transition: exactly one step back. `entry` is how the overlay was
 * opened — paste/oauth always return to the method picker, the method picker
 * returns to the model picker only when the picker was the entry point
 * (a direct `/models <ref>` arg skipped it), and picker/confirm close
 * (undefined).
 */
export function backStep(step: WizardStep, entry: "picker" | "direct"): WizardStep | undefined {
  if (step.kind === "paste" || step.kind === "oauth") return { kind: "method", target: step.target }
  if (step.kind === "method" && entry === "picker") return { kind: "picker" }
  return undefined
}
