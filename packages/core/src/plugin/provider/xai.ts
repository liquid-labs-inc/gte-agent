import { Effect } from "effect"
import { Plugin } from "../../plugin"
import { Provider } from "../../provider"

export const XAIPlugin = Plugin.define({
  id: Plugin.ID.make("xai"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/xai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
        evt.sdk = mod.createXai(evt.options)
      }),
      "aisdk.language": Effect.fn(function* (evt) {
        if (evt.model.providerID !== Provider.ID.make("xai")) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
    }
  }),
})
