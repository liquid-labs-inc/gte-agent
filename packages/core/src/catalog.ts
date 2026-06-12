export * as Catalog from "./catalog"

import { Context, Effect, Layer, Option, Order, pipe, Schema, Array, Scope, Stream } from "effect"
import { castDraft, enableMapSet, type Draft } from "immer"
import { CatalogCurated } from "./catalog-curated"
import { Model } from "./model"
import { Plugin } from "./plugin"
import { Provider } from "./provider"
import { RuntimeScope } from "./runtime-scope"
import { Event } from "./event"
import { Policy } from "./policy"
import { State } from "./state"

export type ProviderRecord = {
  provider: Provider.Info
  models: Map<Model.ID, Model.Info>
}

export type DefaultModel = { providerID: Provider.ID; modelID: Model.ID }

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "Catalog.ProviderNotFound",
  {
    providerID: Provider.ID,
  },
) {}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("Catalog.ModelNotFound", {
  providerID: Provider.ID,
  modelID: Model.ID,
}) {}

export const PolicyActions = Schema.Literals(["provider.use"])

export const CatalogEvent = {
  ModelUpdated: Event.define({
    type: "catalog.model.updated",
    schema: {
      model: Model.Info,
    },
  }),
}

type Data = {
  providers: Map<Provider.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Editor = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: Provider.ID) => ProviderRecord | undefined
    update: (providerID: Provider.ID, fn: (provider: Draft<Provider.Info>) => void) => void
    remove: (providerID: Provider.ID) => void
  }
  model: {
    get: (providerID: Provider.ID, modelID: Model.ID) => Model.Info | undefined
    update: (providerID: Provider.ID, modelID: Model.ID, fn: (model: Draft<Model.Info>) => void) => void
    remove: (providerID: Provider.ID, modelID: Model.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: Provider.ID, modelID: Model.ID) => void
    }
  }
}

export interface Interface {
  readonly transform: State.Interface<Data, Editor>["transform"]
  readonly provider: {
    readonly get: (providerID: Provider.ID) => Effect.Effect<Provider.Info, ProviderNotFoundError>
    readonly all: () => Effect.Effect<Provider.Info[]>
    readonly available: () => Effect.Effect<Provider.Info[]>
  }
  readonly model: {
    readonly get: (
      providerID: Provider.ID,
      modelID: Model.ID,
    ) => Effect.Effect<Model.Info, ProviderNotFoundError | ModelNotFoundError>
    readonly all: () => Effect.Effect<Model.Info[]>
    readonly available: () => Effect.Effect<Model.Info[]>
    readonly default: () => Effect.Effect<Option.Option<Model.Info>>
    readonly small: (providerID: Provider.ID) => Effect.Effect<Option.Option<Model.Info>>
  }
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/Catalog") {}

enableMapSet()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runtimeScope = yield* RuntimeScope.Service
    const plugin = yield* Plugin.Service
    const events = yield* Event.Service
    const policy = yield* Policy.Service
    const scope = yield* Scope.Scope

    const resolve = (model: Model.Info) => {
      const provider = state.get().providers.get(model.providerID)!.provider
      const api =
        model.api.type === "native" && !model.api.url && Object.keys(model.api.settings).length === 0
          ? { ...provider.api, id: model.api.id }
          : model.api.type === "aisdk" && provider.api.type === "aisdk" && !model.api.url
            ? { ...model.api, url: provider.api.url, settings: { ...provider.api.settings, ...model.api.settings } }
            : model.api.type === "aisdk" && provider.api.type === "aisdk"
              ? { ...model.api, settings: { ...provider.api.settings, ...model.api.settings } }
              : model.api
      const request = {
        headers: {
          ...provider.request.headers,
          ...model.request.headers,
        },
        body: {
          ...provider.request.body,
          ...model.request.body,
        },
        variant: model.request.variant,
      }
      return new Model.Info({
        ...model,
        api,
        request,
      })
    }

    function* getRecord(providerID: Provider.ID) {
      const match = state.get().providers.get(providerID)
      if (!match) return yield* new ProviderNotFoundError({ providerID })
      return match
    }

    const normalizeApi = (item: Draft<Provider.Info> | Draft<Model.Info>) => {
      if (typeof item.request.body.baseURL !== "string") return
      item.api.url = item.request.body.baseURL
      delete item.request.body.baseURL
    }

    const state = State.create<Data, Editor>({
      // The catalog baseline is the curated, static, GTE-owned provider/model
      // list. Transforms (config overrides, plugins, policy) layer on top and
      // replay over this baseline on every rebuild; there is no network
      // catalog source.
      initial: () => ({ providers: CatalogCurated.providers() }),
      editor: (draft) => {
        const result: Editor = {
          provider: {
            list: () => Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = castDraft({
                  provider: Provider.Info.empty(providerID),
                  models: new Map<Model.ID, Model.Info>(),
                })
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
              normalizeApi(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) => draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = castDraft({
                  provider: Provider.Info.empty(providerID),
                  models: new Map<Model.ID, Model.Info>(),
                })
                draft.providers.set(providerID, record)
              }
              const model = record.models.get(modelID) ?? castDraft(Model.Info.empty(providerID, modelID))
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
              normalizeApi(model)
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("Catalog.finalize")(function* (catalog, reason) {
        if (reason !== "plugin.added") yield* plugin.trigger("catalog.transform", catalog, {}).pipe(Effect.asVoid)
        if (!policy.hasStatements()) return
        for (const record of [...catalog.provider.list()]) {
          if ((yield* policy.evaluate("provider.use", record.provider.id, "allow")) === "deny") {
            catalog.provider.remove(record.provider.id)
          }
        }
      }),
    })

    yield* events.subscribe(Plugin.PluginEvent.Added).pipe(
      // Plugin registries are runtime-scope scoped even though the event bus is process scoped.
      Stream.filter((event) => event.runtimeScope?.directory === runtimeScope.directory),
      Stream.runForEach((event) =>
        state.update((catalog) => plugin.triggerFor(event.data.id, "catalog.transform", catalog, {}), "plugin.added"),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const result: Interface = {
      transform: state.transform,

      provider: {
        get: Effect.fn("Catalog.provider.get")(function* (providerID) {
          const record = yield* getRecord(providerID)
          return record.provider
        }),

        all: Effect.fn("Catalog.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map((record) => record.provider)
        }),

        available: Effect.fn("Catalog.provider.available")(function* () {
          return Array.fromIterable(state.get().providers.values())
            .map((record) => record.provider)
            .filter((provider) => provider.enabled)
        }),
      },

      model: {
        get: Effect.fn("Catalog.model.get")(function* (providerID, modelID) {
          const record = yield* getRecord(providerID)
          const model = record.models.get(modelID)
          if (!model) return yield* new ModelNotFoundError({ providerID, modelID })
          return resolve(model)
        }),

        all: Effect.fn("Catalog.model.all")(function* () {
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => Array.fromIterable(record.models.values())),
            Array.map(resolve),
            Array.sortWith((item) => item.time.released.epochMilliseconds, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("Catalog.model.available")(function* () {
          return (yield* result.model.all()).filter((model) => {
            const record = state.get().providers.get(model.providerID)
            return record?.provider.enabled !== false && model.enabled
          })
        }),

        default: Effect.fn("Catalog.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID).pipe(Effect.option)
            if (Option.isSome(model) && model.value.enabled) return model
          }

          return pipe(
            yield* result.model.available(),
            Array.sortWith((item) => item.time.released.epochMilliseconds, Order.flip(Order.Number)),
            Array.head,
          )
        }),

        small: Effect.fn("Catalog.model.small")(function* (providerID) {
          const record = state.get().providers.get(providerID)
          if (!record) return Option.none<Model.Info>()

          if (providerID === Provider.ID.gteAgent) {
            const gpt5Nano = record.models.get(Model.ID.make("gpt-5-nano"))
            if (gpt5Nano?.enabled && gpt5Nano.status === "active") return Option.some(resolve(gpt5Nano))
          }

          const candidates = pipe(
            Array.fromIterable(record.models.values()),
            Array.filter(
              (model) =>
                model.providerID === providerID &&
                model.enabled &&
                model.status === "active" &&
                model.capabilities.input.some((item) => item.startsWith("text")) &&
                model.capabilities.output.some((item) => item.startsWith("text")),
            ),
            Array.map((model) => ({
              model,
              cost: model.cost[0] ? model.cost[0].input + model.cost[0].output : 999,
              age: (Date.now() - model.time.released.epochMilliseconds) / (1000 * 60 * 60 * 24 * 30),
              small: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
            })),
            Array.filter((item) => item.cost > 0 && item.age <= 18),
          )

          const pick = (items: typeof candidates) => {
            const maxCost = Math.max(...items.map((item) => item.cost), 0.01)
            const maxAge = Math.max(...items.map((item) => item.age), 0.01)
            return pipe(
              items,
              Array.sortWith((item) => (item.cost / maxCost) * 0.8 + (item.age / maxAge) * 0.2, Order.Number),
              Array.map((item) => resolve(item.model)),
              Array.head,
            )
          }

          return pipe(
            candidates,
            Array.filter((item) => item.small),
            (items) => (items.length > 0 ? pick(items) : pick(candidates)),
          )
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const runtimeScopeLayer = layer.pipe(
  Layer.provideMerge(Plugin.runtimeScopeLayer),
  Layer.provideMerge(Policy.runtimeScopeLayer),
)
