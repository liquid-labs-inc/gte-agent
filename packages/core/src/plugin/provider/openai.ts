import { Effect } from "effect"
import { Model } from "../../model"
import { Plugin } from "../../plugin"
import { Provider } from "../../provider"

export const OpenAIPlugin = Plugin.define({
  id: Plugin.ID.make("openai"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/openai") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/openai"))
        evt.sdk = mod.createOpenAI(evt.options)
      }),
      "aisdk.language": Effect.fn(function* (evt) {
        if (evt.model.providerID !== Provider.ID.openai) return
        evt.language = evt.sdk.responses(evt.model.api.id)
      }),
      "catalog.transform": Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai") continue
          if (!item.models.has(Model.ID.make("gpt-5-chat-latest"))) continue
          evt.model.update(item.provider.id, Model.ID.make("gpt-5-chat-latest"), (model) => {
            // OpenAIPlugin sends OpenAI models through Responses; this alias is a
            // chat-completions-only model, so hide it only from OpenAI's catalog.
            model.enabled = false
          })
        }
      }),
    }
  }),
})
