import { Effect, Layer, LayerMap } from "effect"
import { RuntimeScope } from "./runtime-scope"
import { Policy } from "./policy"
import { Config } from "./config"
import { Plugin } from "./plugin"
import { Catalog } from "./catalog"
import { Project } from "./project"
import { Event } from "./event"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Permission } from "./permission"
import { ToolRegistry } from "./tool/registry"
import { ApplicationTools } from "./tool/application-tools"

export class RuntimeScopeServiceMap extends LayerMap.Service<RuntimeScopeServiceMap>()(
  "@gte-agent/RuntimeScopeServiceMap",
{
  lookup: (ref: RuntimeScope.Ref) => {
    const runtimeScope = RuntimeScope.layer(ref)
    const permission = Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "allow" }),
        assert: () => Effect.void,
        reply: (input) => Effect.fail(new Permission.NotFoundError({ requestID: input.requestID })),
        get: () => Effect.succeed(undefined),
        list: () => Effect.succeed([]),
        forSession: () => Effect.succeed([]),
      }),
    )
    const services = Layer.mergeAll(
      runtimeScope,
      Policy.runtimeScopeLayer,
      Config.runtimeScopeLayer,
      Plugin.runtimeScopeLayer,
      Catalog.runtimeScopeLayer,
      permission,
      ToolRegistry.layer.pipe(Layer.provide(permission)),
    ).pipe(Layer.provideMerge(runtimeScope))
    return services.pipe(Layer.fresh)
  },
  idleTimeToLive: "60 minutes",
  dependencies: [
    Project.defaultLayer,
    Event.defaultLayer,
    FSUtil.defaultLayer,
    Global.defaultLayer,
    ApplicationTools.layer,
  ],
}) {}
