import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const DeepInfraPlugin = Plugin.define({
  id: Plugin.ID.make("deepinfra"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/deepinfra") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/deepinfra"))
        evt.sdk = mod.createDeepInfra(evt.options)
      }),
    }
  }),
})
