import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const ZenmuxPlugin = Plugin.define({
  id: Plugin.ID.make("zenmux"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://zenmux.ai/api/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] ??= "https://gte-agent.ai/"
            provider.request.headers["X-Title"] ??= "gte-agent"
          })
        }
      }),
    }
  }),
})
