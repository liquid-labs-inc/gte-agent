import { Effect } from "effect"
import { Model } from "../../model"
import { Plugin } from "../../plugin"
import { Provider } from "../../provider"

function shouldUseResponses(modelID: string) {
  // Copilot supports Responses for GPT-5 class models, except mini variants
  // which still need the chat-completions endpoint.
  const match = /^gpt-(\d+)/.exec(modelID)
  if (!match) return false
  return Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")
}

export const GithubCopilotPlugin = Plugin.define({
  id: Plugin.ID.make("github-copilot"),
  effect: Effect.gen(function* () {
    return {
      "aisdk.sdk": Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/github-copilot") return
        const mod = yield* Effect.promise(() => import("../../github-copilot/copilot-provider"))
        evt.sdk = mod.createOpenaiCompatible(evt.options)
      }),
      "aisdk.language": Effect.fn(function* (evt) {
        if (evt.model.providerID !== Provider.ID.githubCopilot) return
        if (evt.sdk.responses === undefined && evt.sdk.chat === undefined) {
          evt.language = evt.sdk.languageModel(evt.model.api.id)
          return
        }
        evt.language = shouldUseResponses(evt.model.api.id)
          ? evt.sdk.responses(evt.model.api.id)
          : evt.sdk.chat(evt.model.api.id)
      }),
      "catalog.transform": Effect.fn(function* (evt) {
        const item = evt.provider.get(Provider.ID.githubCopilot)
        if (!item || !item.models.has(Model.ID.make("gpt-5-chat-latest"))) return
        evt.model.update(item.provider.id, Model.ID.make("gpt-5-chat-latest"), (model) => {
          // This chat-only alias conflicts with the Copilot GPT-5 Responses route,
          // so hide it only for Copilot rather than for every provider catalog.
          model.enabled = false
        })
      }),
    }
  }),
})
