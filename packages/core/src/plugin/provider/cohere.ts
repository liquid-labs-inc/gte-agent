import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const CoherePlugin = Plugin.define({
  id: Plugin.ID.make("cohere"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/cohere") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/cohere"))
        evt.sdk = mod.createCohere(evt.options)
      }),
    }
  }),
})
