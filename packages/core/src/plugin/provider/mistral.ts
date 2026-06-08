import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const MistralPlugin = Plugin.define({
  id: Plugin.ID.make("mistral"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/mistral") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/mistral"))
        evt.sdk = mod.createMistral(evt.options)
      }),
    }
  }),
})
