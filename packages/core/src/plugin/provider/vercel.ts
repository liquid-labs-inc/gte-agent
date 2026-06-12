import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const VercelPlugin = Plugin.define({
  id: Plugin.ID.make("vercel"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/vercel") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["http-referer"] = "https://gte-agent.ai/"
            provider.request.headers["x-title"] = "gte-agent"
          })
        }
      }),
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/vercel") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/vercel"))
        evt.sdk = mod.createVercel(evt.options)
      }),
    }
  }),
})
