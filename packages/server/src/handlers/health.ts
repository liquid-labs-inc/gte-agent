import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"

export const healthHandlers = HttpApiBuilder.group(GTEAgentApi, "health", (handlers) =>
  handlers.handle("health", () => Effect.succeed({ healthy: true as const })),
)
