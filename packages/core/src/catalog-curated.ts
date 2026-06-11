export * as CatalogCurated from "./catalog-curated"

import { DateTime } from "effect"
import type { ProviderRecord } from "./catalog"
import { Model } from "./model"
import { Provider } from "./provider"

// Curated, static, GTE-owned model catalog (Milestone 7).
//
// Provider/model policy is GTE-owned: this list is the only source of catalog
// entries — there is no models.dev fetch and no provider /models discovery.
// Updates land as code changes. IDs, context/output limits, capabilities, and
// costs (USD per million tokens) were verified against provider docs and
// models.dev at implementation time (2026-06-11).
//
// Providers are enabled via their env var so the existing session-runner
// credential fallback (provider.enabled.via === "env") keeps working; the
// auth store resolves ~/.gte-agent/auth.json profiles ahead of the env var.

const released = (date: string) => DateTime.makeUnsafe(Date.parse(date))

const model = (input: {
  providerID: Provider.ID
  id: string
  name: string
  family: string
  released: string
  cost: (typeof Model.Cost.Type)[]
  limit: { context: number; input?: number; output: number }
  input?: string[]
}) =>
  new Model.Info({
    id: Model.ID.make(input.id),
    providerID: input.providerID,
    family: Model.Family.make(input.family),
    name: input.name,
    // A bare native api inherits the provider's aisdk api (package, url,
    // settings) at Catalog resolve time, keeping routing provider-owned.
    api: { id: Model.ID.make(input.id), type: "native", settings: {} },
    capabilities: {
      // Every curated model supports tool calling; the session runner relies
      // on this flag to advertise the read-only GTE data tools.
      tools: true,
      input: input.input ?? ["text", "image", "pdf"],
      output: ["text"],
    },
    request: { headers: {}, body: {} },
    variants: [],
    time: { released: released(input.released) },
    cost: input.cost,
    status: "active",
    enabled: true,
    limit: input.limit,
  })

const record = (provider: Provider.Info, models: Model.Info[]): ProviderRecord => ({
  provider,
  models: new Map(models.map((item) => [item.id, item])),
})

const anthropic = () => {
  const providerID = Provider.ID.anthropic
  return record(
    new Provider.Info({
      id: providerID,
      name: "Anthropic",
      enabled: { via: "env", name: "ANTHROPIC_API_KEY" },
      env: ["ANTHROPIC_API_KEY"],
      api: { type: "aisdk", package: "@ai-sdk/anthropic" },
      request: { headers: {}, body: {} },
    }),
    [
      model({
        providerID,
        id: "claude-fable-5",
        name: "Claude Fable 5",
        family: "claude-fable",
        released: "2026-06-09",
        cost: [{ input: 10, output: 50, cache: { read: 1, write: 12.5 } }],
        limit: { context: 1_000_000, output: 128_000 },
      }),
      model({
        providerID,
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        family: "claude-opus",
        released: "2026-05-28",
        cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }],
        limit: { context: 1_000_000, output: 128_000 },
      }),
      model({
        providerID,
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        family: "claude-sonnet",
        released: "2026-02-17",
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
        limit: { context: 1_000_000, output: 64_000 },
      }),
      model({
        providerID,
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        family: "claude-haiku",
        released: "2025-10-15",
        cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }],
        limit: { context: 200_000, output: 64_000 },
      }),
    ],
  )
}

const openai = () => {
  const providerID = Provider.ID.openai
  return record(
    new Provider.Info({
      id: providerID,
      name: "OpenAI",
      enabled: { via: "env", name: "OPENAI_API_KEY" },
      env: ["OPENAI_API_KEY"],
      api: { type: "aisdk", package: "@ai-sdk/openai" },
      request: { headers: {}, body: {} },
    }),
    [
      model({
        providerID,
        id: "gpt-5.5",
        name: "GPT-5.5",
        family: "gpt",
        released: "2026-04-23",
        // Prompts above 272K input tokens bill the whole request at the
        // higher tier (2x input, 1.5x output). OpenAI does not charge for
        // cache writes.
        cost: [
          { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
          { tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache: { read: 1, write: 0 } },
        ],
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      }),
      model({
        providerID,
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        released: "2026-03-05",
        cost: [
          { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
          { tier: { type: "context", size: 272_000 }, input: 5, output: 22.5, cache: { read: 0.5, write: 0 } },
        ],
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      }),
      model({
        providerID,
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        family: "gpt-mini",
        released: "2026-03-17",
        cost: [{ input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } }],
        limit: { context: 400_000, input: 272_000, output: 128_000 },
        input: ["text", "image"],
      }),
    ],
  )
}

/**
 * Fresh provider records for the curated catalog.
 *
 * Returns new instances on every call: this seeds `State.create`'s `initial`
 * state in the Catalog service, which is rebuilt from `initial()` plus active
 * transforms — shared instances would leak transform mutations across
 * rebuilds.
 */
export const providers = (): Map<Provider.ID, ProviderRecord> =>
  new Map([anthropic(), openai()].map((item) => [item.provider.id, item]))
