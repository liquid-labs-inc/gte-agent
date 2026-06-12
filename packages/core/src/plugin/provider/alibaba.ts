import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const AlibabaPlugin = Plugin.define({
  id: Plugin.ID.make("alibaba"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/alibaba") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/alibaba"))
        evt.sdk = mod.createAlibaba(evt.options)
      }),
    }
  }),
})
