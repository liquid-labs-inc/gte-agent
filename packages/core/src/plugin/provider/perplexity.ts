import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const PerplexityPlugin = Plugin.define({
  id: Plugin.ID.make("perplexity"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/perplexity") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/perplexity"))
        evt.sdk = mod.createPerplexity(evt.options)
      }),
    }
  }),
})
