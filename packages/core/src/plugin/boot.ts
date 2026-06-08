export * as PluginBoot from "./boot"

import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly wait: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/PluginBoot") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    wait: () => Effect.void,
  }),
)

export const runtimeScopeLayer = layer
