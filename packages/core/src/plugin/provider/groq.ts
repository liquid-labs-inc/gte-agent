import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const GroqPlugin = Plugin.define({
  id: Plugin.ID.make("groq"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/groq") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/groq"))
        evt.sdk = mod.createGroq(evt.options)
      }),
    }
  }),
})
