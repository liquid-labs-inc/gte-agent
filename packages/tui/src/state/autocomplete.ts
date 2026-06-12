/**
 * Prompt autocomplete logic (Milestone 7).
 *
 * Pure functions for the slash-command dropdown: derive what to complete from
 * the raw input text (`completionRequest`), fuzzy-filter candidates
 * (`filterCommands` / `filterItems`), apply an accepted item back onto the
 * text (`acceptCompletion`), and move the highlight (`moveSelection`).
 *
 * Arg completion is source-driven: command specs declare positional
 * `argCompletions` sources (see commands/slash.ts) and the TUI supplies one
 * async data provider per source kind (`createCompletionSources`). Adding a
 * new source kind needs a declaration on the spec plus a provider here —
 * nothing in the dropdown or input wiring changes.
 */
import fuzzysort from "fuzzysort"
import type { GteApi } from "../api/gte"
import type { ModelsApi, ModelsCatalog } from "../api/models"
import type { ArgCompletionSource, CommandSpec } from "../commands/slash"
import { authLabel } from "./models"

export type CompletionItem = {
  /** Exact text placed into the prompt when accepted. */
  readonly insert: string
  readonly label: string
  /** Muted annotation rendered next to the label (usage, auth status, …). */
  readonly detail?: string
}

export type CompletionRequest =
  | { readonly stage: "command"; readonly query: string }
  | {
      readonly stage: "arg"
      readonly source: ArgCompletionSource
      readonly query: string
      /** Index in the input text where the token being completed starts. */
      readonly replaceFrom: number
    }

/**
 * Maximum dropdown candidates kept after fuzzy filtering. An empty command
 * query deliberately bypasses the cap so the full (curated, finite) registry
 * stays browsable; provider-fed arg candidates are capped on both paths
 * because their lists are unbounded.
 */
export const MAX_COMPLETIONS = 16

/**
 * What (if anything) should be completed for the current input text.
 * Undefined means the dropdown stays closed: non-slash input, an unknown or
 * completion-less command, or an arg position with no declared source.
 */
export function completionRequest(text: string, commands: readonly CommandSpec[]): CompletionRequest | undefined {
  // parseSlashCommand trims before executing, so "  /book" still runs as a
  // slash command; completion tolerates leading whitespace the same way.
  const body = text.trimStart()
  if (!body.startsWith("/")) return undefined
  const spaceIndex = body.search(/\s/)
  if (spaceIndex === -1) return { stage: "command", query: body.slice(1) }
  const spec = commands.find((candidate) => candidate.name === body.slice(1, spaceIndex).toLowerCase())
  if (spec?.argCompletions === undefined) return undefined
  const args = body
    .slice(spaceIndex)
    .split(/\s+/)
    .filter((part) => part.length > 0)
  // A trailing space starts the next arg; otherwise the last token is refined.
  const startingNext = /\s$/.test(body)
  const query = startingNext ? "" : (args[args.length - 1] ?? "")
  const source = spec.argCompletions[startingNext ? args.length : args.length - 1]
  if (source === undefined) return undefined
  // The query token is end-anchored, so replaceFrom indexes the ORIGINAL text.
  return { stage: "arg", source, query, replaceFrom: text.length - query.length }
}

/** Slash-command candidates: full registry for an empty query, fuzzy otherwise. */
export function filterCommands(commands: readonly CommandSpec[], query: string): readonly CompletionItem[] {
  const items = commands.map((spec) => ({ insert: `/${spec.name}`, label: `/${spec.name}`, detail: spec.usage }))
  if (query.length === 0) return items
  return fuzzysort.go(query, items, { key: "label", limit: MAX_COMPLETIONS }).map((result) => result.obj)
}

/** Fuzzy-rank provider-supplied arg candidates against the current token. */
export function filterItems(items: readonly CompletionItem[], query: string): readonly CompletionItem[] {
  if (query.length === 0) return items.slice(0, MAX_COMPLETIONS)
  return fuzzysort.go(query, items, { key: "insert", limit: MAX_COMPLETIONS }).map((result) => result.obj)
}

/** Input text after accepting an item. Command acceptance flows into arg entry. */
export function acceptCompletion(text: string, request: CompletionRequest, item: CompletionItem): string {
  if (request.stage === "command") return `${item.insert} `
  return text.slice(0, request.replaceFrom) + item.insert
}

/** Wrap-around highlight movement. */
export function moveSelection(count: number, selected: number, delta: number): number {
  if (count <= 0) return 0
  return (selected + delta + count) % count
}

export type CompletionSources = Record<ArgCompletionSource, (query: string) => Promise<readonly CompletionItem[]>>

/** Catalog responses stay valid this long for the dropdown; auth changes show up on the next fetch. */
export const MODEL_REF_CACHE_MS = 10_000

/**
 * Data providers for the declared arg-completion sources. Symbols ride the
 * existing read-only symbol-resolution surface, so candidates always come
 * from the canonical market list and never get invented client-side.
 * Model refs come from the curated catalog route (with auth-status detail);
 * the catalog is static per process, so responses are briefly cached to keep
 * per-keystroke fetches off the wire.
 */
export function createCompletionSources(gte: GteApi, models?: ModelsApi): CompletionSources {
  let cached: { promise: Promise<ModelsCatalog>; at: number } | undefined
  const catalog = () => {
    if (models === undefined) return undefined
    if (cached === undefined || Date.now() - cached.at > MODEL_REF_CACHE_MS) {
      const promise = models.list()
      cached = { promise, at: Date.now() }
      // A failed fetch must not poison the cache window.
      promise.catch(() => {
        if (cached?.promise === promise) cached = undefined
      })
    }
    return cached.promise
  }
  return {
    symbol: async (query) => {
      const resolution = await gte.resolveSymbol(query)
      if (resolution.outcome === "resolved") return [{ insert: resolution.symbol, label: resolution.symbol }]
      if (resolution.outcome === "ambiguous") {
        return resolution.candidates.map((symbol) => ({ insert: symbol, label: symbol }))
      }
      return []
    },
    "model-ref": async () => {
      const pending = catalog()
      if (pending === undefined) return []
      const result = await pending
      return result.providers.flatMap((provider) =>
        provider.models.map((model) => ({
          insert: `${provider.id}/${model.id}`,
          label: `${provider.id}/${model.id}`,
          detail: model.isDefault ? `${authLabel(provider.auth)} · default` : authLabel(provider.auth),
        })),
      )
    },
  }
}
