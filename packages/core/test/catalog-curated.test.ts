import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { CatalogCurated } from "@gte-agent/core/catalog-curated"
import { Event } from "@gte-agent/core/event"
import { Model } from "@gte-agent/core/model"
import { Provider } from "@gte-agent/core/provider"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "./fixture/runtime-scope"
import { testEffect } from "./lib/effect"

const runtimeScopeLayer = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)
const it = testEffect(
  Catalog.runtimeScopeLayer.pipe(Layer.provideMerge(Event.defaultLayer), Layer.provideMerge(runtimeScopeLayer)),
)

const CURATED = {
  anthropic: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
}

describe("Catalog curated entries", () => {
  it.effect("seeds exactly the curated providers and models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service

      const providers = yield* catalog.provider.all()
      expect(providers.map((provider) => provider.id).sort()).toEqual([Provider.ID.anthropic, Provider.ID.openai])

      const models = yield* catalog.model.all()
      expect(
        models
          .map((model) => `${model.providerID}/${model.id}`)
          .sort(),
      ).toEqual(
        Object.entries(CURATED)
          .flatMap(([providerID, ids]) => ids.map((id) => `${providerID}/${id}`))
          .sort(),
      )
    }),
  )

  it.effect("enables curated providers via their provider env var", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service

      const anthropic = yield* catalog.provider.get(Provider.ID.anthropic)
      expect(anthropic.name).toBe("Anthropic")
      expect(anthropic.enabled).toEqual({ via: "env", name: "ANTHROPIC_API_KEY" })
      expect(anthropic.env).toEqual(["ANTHROPIC_API_KEY"])
      expect(anthropic.api).toEqual({ type: "aisdk", package: "@ai-sdk/anthropic" })

      const openai = yield* catalog.provider.get(Provider.ID.openai)
      expect(openai.name).toBe("OpenAI")
      expect(openai.enabled).toEqual({ via: "env", name: "OPENAI_API_KEY" })
      expect(openai.env).toEqual(["OPENAI_API_KEY"])
      expect(openai.api).toEqual({ type: "aisdk", package: "@ai-sdk/openai" })
    }),
  )

  it.effect("resolves every curated model to its provider's aisdk api", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      for (const [providerID, ids] of Object.entries(CURATED)) {
        for (const id of ids) {
          const model = yield* catalog.model.get(Provider.ID.make(providerID), Model.ID.make(id))
          expect(model.api).toEqual({
            id: Model.ID.make(id),
            type: "aisdk",
            package: providerID === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai",
          })
        }
      }
    }),
  )

  it.effect("marks every curated model tool-capable, enabled, and active", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const models = yield* catalog.model.all()
      for (const model of models) {
        expect(model.capabilities.tools).toBe(true)
        expect(model.capabilities.input).toContain("text")
        expect(model.capabilities.output).toContain("text")
        expect(model.enabled).toBe(true)
        expect(model.status).toBe("active")
        expect(model.time.released.epochMilliseconds).toBeGreaterThan(0)
        expect(model.cost.length).toBeGreaterThan(0)
      }
    }),
  )

  it.effect("includes every curated model in the available set", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const available = yield* catalog.model.available()
      expect(available.length).toBe(7)
    }),
  )

  it.effect("carries verified context and output limits", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const limit = (providerID: string, id: string) =>
        catalog.model
          .get(Provider.ID.make(providerID), Model.ID.make(id))
          .pipe(Effect.map((model) => model.limit))

      expect(yield* limit("anthropic", "claude-fable-5")).toEqual({ context: 1_000_000, output: 128_000 })
      expect(yield* limit("anthropic", "claude-opus-4-8")).toEqual({ context: 1_000_000, output: 128_000 })
      expect(yield* limit("anthropic", "claude-sonnet-4-6")).toEqual({ context: 1_000_000, output: 64_000 })
      expect(yield* limit("anthropic", "claude-haiku-4-5")).toEqual({ context: 200_000, output: 64_000 })
      expect(yield* limit("openai", "gpt-5.5")).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
      expect(yield* limit("openai", "gpt-5.4")).toEqual({ context: 1_050_000, input: 922_000, output: 128_000 })
      expect(yield* limit("openai", "gpt-5.4-mini")).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    }),
  )

  it.effect("carries verified base costs and context tiers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service

      const fable = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-fable-5"))
      expect(fable.cost).toEqual([{ input: 10, output: 50, cache: { read: 1, write: 12.5 } }])

      const haiku = yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-haiku-4-5"))
      expect(haiku.cost).toEqual([{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }])

      const gpt55 = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.5"))
      expect(gpt55.cost).toEqual([
        { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        { tier: { type: "context", size: 272_000 }, input: 10, output: 45, cache: { read: 1, write: 0 } },
      ])

      const mini = yield* catalog.model.get(Provider.ID.openai, Model.ID.make("gpt-5.4-mini"))
      expect(mini.cost).toEqual([{ input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } }])
    }),
  )

  it.effect("defines reasoning-effort variants for the curated Anthropic models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const variants = (id: string) =>
        catalog.model.get(Provider.ID.anthropic, Model.ID.make(id)).pipe(Effect.map((model) => model.variants))

      const adaptive = (effort: string) => ({
        id: Model.VariantID.make(effort),
        headers: {},
        body: { providerOptions: { anthropic: { thinking: { type: "adaptive", effort } } } },
      })
      const budgeted = (id: string, budgetTokens: number) => ({
        id: Model.VariantID.make(id),
        headers: {},
        body: { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens } } } },
      })

      // Adaptive-efforts generations carry the full effort ladder; the
      // protocol forces display: "summarized" for them, so the catalog
      // payload stays effort-only.
      const adaptiveLadder = ["low", "medium", "high", "xhigh", "max"].map(adaptive)
      expect(yield* variants("claude-fable-5")).toEqual(adaptiveLadder)
      expect(yield* variants("claude-opus-4-8")).toEqual(adaptiveLadder)

      // Sonnet 4.6 is adaptive upstream without `xhigh` and without the
      // display override; Haiku 4.5 stays on legacy budgeted thinking.
      expect(yield* variants("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"].map(adaptive))
      expect(yield* variants("claude-haiku-4-5")).toEqual([budgeted("high", 16_000), budgeted("max", 31_999)])
    }),
  )

  it.effect("leaves the curated OpenAI models without variants", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      for (const id of CURATED.openai) {
        const model = yield* catalog.model.get(Provider.ID.openai, Model.ID.make(id))
        expect(model.variants).toEqual([])
      }
    }),
  )

  it.effect("defaults to the newest curated model when nothing else is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const selected = Option.getOrUndefined(yield* catalog.model.default())
      expect(selected?.providerID).toBe(Provider.ID.anthropic)
      expect(selected?.id).toBe(Model.ID.make("claude-fable-5"))
    }),
  )

  it.effect("keeps the curated baseline intact when a transform mutates and is replaced", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const transform = yield* catalog.transform()

      yield* transform((editor) => {
        editor.model.update(Provider.ID.anthropic, Model.ID.make("claude-fable-5"), (model) => {
          model.enabled = false
        })
        editor.provider.remove(Provider.ID.openai)
      })
      expect((yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-fable-5"))).enabled).toBe(false)
      expect(yield* catalog.provider.get(Provider.ID.openai).pipe(Effect.option)).toEqual(Option.none())

      // Replacing the transform rebuilds from the curated baseline.
      yield* transform(() => {})
      expect((yield* catalog.model.get(Provider.ID.anthropic, Model.ID.make("claude-fable-5"))).enabled).toBe(true)
      expect((yield* catalog.provider.get(Provider.ID.openai)).name).toBe("OpenAI")
    }),
  )

  it.effect("never reuses curated instances across calls", () =>
    Effect.gen(function* () {
      const first = CatalogCurated.providers()
      const second = CatalogCurated.providers()
      expect(first).not.toBe(second)
      const firstAnthropic = first.get(Provider.ID.anthropic)
      const secondAnthropic = second.get(Provider.ID.anthropic)
      expect(firstAnthropic?.provider).not.toBe(secondAnthropic?.provider)
      expect(firstAnthropic?.models.get(Model.ID.make("claude-fable-5"))).not.toBe(
        secondAnthropic?.models.get(Model.ID.make("claude-fable-5")),
      )
      expect(firstAnthropic?.models.get(Model.ID.make("claude-fable-5"))?.variants).not.toBe(
        secondAnthropic?.models.get(Model.ID.make("claude-fable-5"))?.variants,
      )
    }),
  )
})
