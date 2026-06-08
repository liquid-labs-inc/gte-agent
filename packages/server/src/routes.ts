import { GTEAuth } from "@gte-agent/core/gte-auth"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { GTEAgentApi } from "./api"
import { ServerAuth } from "./auth"
import { gteAgentHandlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"

export function createRoutes(password?: string) {
  return HttpApiBuilder.layer(GTEAgentApi).pipe(
    Layer.provide(gteAgentHandlers),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(
      password
        ? ServerAuth.Config.layer({ username: "gte-agent", password: Option.some(password) })
        : ServerAuth.Config.defaultLayer,
    ),
    Layer.provide(GTEAuth.ConfigService.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
