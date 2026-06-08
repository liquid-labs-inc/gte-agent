import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { GTEAuthorization } from "../middleware/authorization"

export const HealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/api/health", {
      success: Schema.Struct({ healthy: Schema.Literal(true) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "health.get",
        summary: "Check GTE Agent server health",
        description: "Check whether the GTE Agent API server is ready to accept requests.",
      }),
    ),
  )
  .middleware(GTEAuthorization)
