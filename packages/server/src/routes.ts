import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Log } from "@gte-agent/core/util/log"
import { Observability } from "@gte-agent/core/effect/observability"
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

/**
 * Point runtime logs at the shared log file instead of stderr. Embedders
 * that own the terminal (the TUI worker) call this before serving so
 * runtime logs cannot scribble over their UI. Returns the log file path.
 */
export async function initFileLog(): Promise<string> {
  await Log.init({ print: false })
  return Log.file()
}

// The core logger layer routes runtime logs (e.g. session-drain failures)
// through util/log, which writes to stderr until initFileLog points it at a
// file.
export const webHandler = () =>
  HttpRouter.toWebHandler(
    // Merged so request fibers log through it, and provided so fibers forked
    // while the inner layers build (e.g. session-drain fibers) do too.
    Layer.mergeAll(routes.pipe(Layer.provide(Observability.layer)), Observability.layer).pipe(
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
