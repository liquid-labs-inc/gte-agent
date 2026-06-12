import { Npm } from "@gte-agent/core/npm"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Model } from "@gte-agent/core/model"
import { Plugin } from "@gte-agent/core/plugin"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "../fixture/runtime-scope"
import { testEffect } from "../lib/effect"

export const fixtureProvider = new URL("./fixtures/provider-factory.ts", import.meta.url).href
const runtimeScopeLayer = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)

export const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: Option.none<string>() }),
    install: () => Effect.void,
    which: () => Effect.succeed(Option.none<string>()),
  }),
)

export const catalogLayer = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.die("unexpected provider.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: () => Effect.die("unexpected model.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none<Model.Info>()),
      small: () => Effect.succeed(Option.none<Model.Info>()),
    },
  }),
)

export const it = testEffect(
  Catalog.runtimeScopeLayer.pipe(
    Layer.provideMerge(Event.layer.pipe(Layer.provide(Database.layerFromPath(":memory:")))),
    Layer.provideMerge(runtimeScopeLayer),
    Layer.provideMerge(npmLayer),
  ),
)

type ProviderInput = Partial<Omit<Provider.Info, "api" | "request">> & {
  api?: Provider.Api
  request?: Provider.Request
}

type ModelInput = Partial<Omit<Model.Info, "api" | "request">> & {
  api?: (Provider.Api & { id?: Model.ID }) | { id: Model.ID }
  request?: Model.Info["request"]
}

export function provider(providerID: string, options?: ProviderInput) {
  return new Provider.Info({
    ...Provider.Info.empty(Provider.ID.make(providerID)),
    api: options?.api ?? {
      type: "aisdk",
      package: "test-provider",
    },
    ...options,
    request: {
      headers: {},
      body: {},
      ...options?.request,
    },
  })
}

export function model(providerID: string, modelID: string, options?: ModelInput) {
  return new Model.Info({
    ...Model.Info.empty(Provider.ID.make(providerID), Model.ID.make(modelID)),
    ...options,
    api:
      options?.api && "type" in options.api
        ? { id: Model.ID.make(modelID), ...options.api }
        : {
            id: Model.ID.make(modelID),
            ...options?.api,
            type: "aisdk",
            package: "test-provider",
          },
    request: {
      headers: {},
      body: {},
      ...options?.request,
    },
  })
}

export function withEnv<A, E, R>(vars: Record<string, string | undefined>, fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => fx(),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

export function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

export function expectPluginRegistered(ids: string[], id: string) {
  expect(ids).toContain(Plugin.ID.make(id))
}
