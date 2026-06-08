import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const TogetherAIPlugin = Plugin.define({
  id: Plugin.ID.make("togetherai"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/togetherai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/togetherai"))
        evt.sdk = mod.createTogetherAI(evt.options)
      }),
    }
  }),
})
