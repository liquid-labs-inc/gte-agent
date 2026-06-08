import { GTEAuth } from "@gte-agent/core/gte-auth"
import { ServerAuth } from "../auth"
import { UnauthorizedError } from "../errors"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

const AUTH_TOKEN_QUERY = "auth_token"

export class GTEAuthorization extends HttpApiMiddleware.Service<GTEAuthorization>()(
  "@gte-agent/HttpApiAuthorization",
  {
    error: UnauthorizedError,
  },
) {}

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers[ServerAuth.DAEMON_AUTHORIZATION_HEADER] ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  GTEAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const gteAuth = yield* GTEAuth.ConfigService
    return GTEAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (ServerAuth.required(config)) {
          const credential = yield* credentialFromRequest(request)
          if (!ServerAuth.authorized(credential, config)) {
            return yield* Effect.fail(new UnauthorizedError({ message: "Daemon transport authentication required" }))
          }
        }
        const authContext = yield* Effect.mapError(
          GTEAuth.authenticate(gteAuth, request.headers.authorization),
          (error) => new UnauthorizedError({ message: error.message }),
        )
        return yield* effect.pipe(Effect.provideService(GTEAuth.RequestContextService, authContext))
      }),
    )
  }),
)
