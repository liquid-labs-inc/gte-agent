import { Effect } from "effect"
import { Plugin } from "../../plugin"

export const LLMGatewayPlugin = Plugin.define({
  id: Plugin.ID.make("llmgateway"),
  effect: Effect.gen(function* () {
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.enabled === false) continue
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://api.llmgateway.io/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] = "https://gte-agent.ai/"
            provider.request.headers["X-Title"] = "gte-agent"
            provider.request.headers["X-Source"] = "gte-agent"
          })
        }
      }),
    }
  }),
})
