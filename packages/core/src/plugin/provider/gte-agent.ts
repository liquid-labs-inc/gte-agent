import { Effect } from "effect"
import { Plugin } from "../../plugin"
import { Provider } from "../../provider"

export const GTEAgentProviderPlugin = Plugin.define({
  id: Plugin.ID.make("gte-agent"),
  effect: Effect.gen(function* () {
    let hasKey = false
    return {
      "catalog.transform": Effect.fn(function* (evt) {
        const item = evt.provider.get(Provider.ID.gteAgent)
        if (!item) return
        hasKey = Boolean(
          process.env.GTE_AGENT_API_KEY ||
            item.provider.env.some((env) => process.env[env]) ||
            item.provider.request.body.apiKey,
        )
        evt.provider.update(item.provider.id, (provider) => {
          if (!hasKey) provider.request.body.apiKey = "public"
        })
        if (hasKey) return
        for (const model of item.models.values()) {
          if (!model.cost.some((cost) => cost.input > 0)) continue
          evt.model.update(item.provider.id, model.id, (draft) => {
            draft.enabled = false
          })
        }
      }),
    }
  }),
})
