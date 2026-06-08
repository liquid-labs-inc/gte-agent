import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const GatewayPlugin = Plugin.define({
  id: Plugin.ID.make("gateway"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/gateway") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/gateway"))
        evt.sdk = mod.createGateway(evt.options)
      }),
    }
  }),
})
