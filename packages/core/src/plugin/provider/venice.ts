import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const VenicePlugin = Plugin.define({
  id: Plugin.ID.make("venice"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "venice-ai-sdk-provider") return
        const mod = yield* Effect.promise(() => import("venice-ai-sdk-provider"))
        evt.sdk = mod.createVenice(evt.options)
      }),
    }
  }),
})
