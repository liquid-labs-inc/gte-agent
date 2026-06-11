import { AuthAnthropic } from "@gte-agent/core/auth/anthropic"
import { AuthOpenAI } from "@gte-agent/core/auth/openai"
import { AuthStore } from "@gte-agent/core/auth/store"
import { Provider } from "@gte-agent/core/provider"
import { Config, Duration, Effect, Exit, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"
import {
  ForbiddenError,
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
  UnknownError,
} from "../errors"

/** Providers with auth flows in this milestone (mirrors the curated catalog). */
const SUPPORTED: readonly Provider.ID[] = [Provider.ID.anthropic, Provider.ID.openai]

/** Pending PKCE flows are dropped after this long; the user starts again. */
const FLOW_TTL_MS = 10 * 60 * 1000

type PendingFlow = {
  readonly providerID: Provider.ID
  readonly verifier: string
  readonly state: string
  readonly createdAt: number
  readonly callback: AuthOpenAI.Callback | undefined
  readonly scope: Scope.Closeable
}

export const authProviderHandlers = HttpApiBuilder.group(GTEAgentApi, "authProvider", (handlers) =>
  Effect.gen(function* () {
    const store = yield* AuthStore.Service
    // Resolved at layer build (FetchHttpClient in routes.ts) and provided into
    // the token exchange explicitly, so handlers carry no per-request
    // HttpClient requirement.
    const httpClient = yield* HttpClient.HttpClient
    // Pending-flow callback listeners are forked from the group layer's scope,
    // so disposing the server stops any listener a flow never completed.
    const rootScope = yield* Scope.Scope
    // Test seams (defaults are the real flow constants): the token issuer, the
    // localhost callback port (0 = ephemeral), and how long `complete` waits
    // for the browser redirect before directing the user to paste it.
    const issuer = yield* Config.string("GTE_AGENT_OPENAI_ISSUER").pipe(Config.withDefault(AuthOpenAI.ISSUER))
    const callbackPort = yield* Config.int("GTE_AGENT_OAUTH_CALLBACK_PORT").pipe(
      Config.withDefault(AuthOpenAI.CALLBACK_PORT),
    )
    const waitMs = yield* Config.int("GTE_AGENT_OAUTH_WAIT_MS").pipe(Config.withDefault(300_000))

    // In-memory pending PKCE flows, keyed by an opaque handle. The verifier and
    // state never leave the server (the state reaches the browser only inside
    // the authorize URL).
    const flows = new Map<string, PendingFlow>()

    const discard = (id: string, flow: PendingFlow) => {
      flows.delete(id)
      return Scope.close(flow.scope, Exit.void).pipe(Effect.ignore)
    }

    const prune = Effect.suspend(() =>
      Effect.forEach(
        [...flows].filter(([, flow]) => Date.now() - flow.createdAt >= FLOW_TTL_MS),
        ([id, flow]) => discard(id, flow),
        { discard: true },
      ),
    )

    // Store failures must not leak file contents (secret material) into the
    // response: log a ref + the error tag, return an opaque 500.
    const storeFailure = (operation: string) => (error: { readonly _tag: string }) => {
      const ref = `err_${crypto.randomUUID().slice(0, 8)}`
      return Effect.logError("auth store operation failed").pipe(
        Effect.annotateLogs({ ref, operation, error: error._tag }),
        Effect.andThen(
          Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref })),
        ),
      )
    }

    const provider = (raw: string) => {
      const match = SUPPORTED.find((id) => id === raw)
      if (match !== undefined) return Effect.succeed(match)
      return Effect.fail(
        new ProviderNotFoundError({
          providerID: raw,
          message: `Unknown LLM provider: ${raw}. Supported: anthropic, openai`,
        }),
      )
    }

    const oauthProvider = Effect.fn("authProvider.oauthProvider")(function* (raw: string) {
      const id = yield* provider(raw)
      if (id === Provider.ID.openai) return id
      return yield* Effect.fail(
        new InvalidRequestError({
          message: `OAuth sign-in is not supported for ${id}; paste an API key${id === Provider.ID.anthropic ? " or setup token" : ""} instead.`,
          field: "provider",
        }),
      )
    })

    // Auth state without secret material: method + booleans only.
    //
    // Env detection reads process.env directly, deliberately mirroring core
    // AuthStore.resolve (which consults the same AuthStore.ENV map against
    // process.env rather than Effect Config). If core credential resolution
    // ever moves to Config-based reads, change both sites together — ideally
    // by having core expose a single hasEnvCredential(providerID) helper.
    const statusFor = Effect.fn("authProvider.statusFor")(function* (providerID: Provider.ID) {
      const profile = yield* store.get(providerID).pipe(Effect.catch(storeFailure("read")))
      if (profile !== undefined) {
        return {
          provider: providerID,
          method: profile.type,
          authed: true,
          accountId: profile.type === "oauth" && profile.accountId !== undefined && profile.accountId.length > 0,
        }
      }
      const env = (AuthStore.ENV[providerID] ?? []).some((name) => (process.env[name] ?? "").length > 0)
      return { provider: providerID, method: env ? ("env" as const) : ("none" as const), authed: env, accountId: false }
    })

    return handlers
      .handle(
        "status",
        Effect.fn(function* () {
          return { data: yield* Effect.forEach(SUPPORTED, statusFor) }
        }),
      )
      .handle(
        "apiKey",
        Effect.fn(function* (ctx) {
          const providerID = yield* provider(ctx.params.provider)
          const key = ctx.payload.key.trim()
          if (key.length === 0)
            return yield* Effect.fail(
              new InvalidRequestError({ message: "Credential must not be blank", field: "key" }),
            )
          if (ctx.payload.type === "setup_token" && providerID !== Provider.ID.anthropic)
            return yield* Effect.fail(
              new InvalidRequestError({
                message: `Setup tokens are an Anthropic credential and cannot be stored for ${providerID}.`,
                field: "type",
              }),
            )
          const profile =
            providerID === Provider.ID.anthropic && ctx.payload.type !== "api_key"
              ? ctx.payload.type === "setup_token"
                ? AuthAnthropic.setupTokenProfile(key)
                : (AuthAnthropic.fromPaste(key) ?? AuthAnthropic.apiKeyProfile(key))
              : AuthAnthropic.apiKeyProfile(key)
          yield* store.set(providerID, profile).pipe(Effect.catch(storeFailure("write")))
          return { data: yield* statusFor(providerID) }
        }),
      )
      .handle(
        "oauthStart",
        Effect.fn(function* (ctx) {
          const providerID = yield* oauthProvider(ctx.params.provider)
          yield* prune
          // One pending flow per provider: restarting a sign-in discards the
          // previous flow and closes its callback listener. Otherwise the
          // stale listener would keep the callback port bound — the new flow
          // could not listen, and the browser redirect from the new authorize
          // URL would land on the old listener and die on a state mismatch.
          yield* Effect.forEach(
            [...flows].filter(([, flow]) => flow.providerID === providerID),
            ([id, flow]) => discard(id, flow),
            { discard: true },
          )
          const flow = AuthOpenAI.flow()
          const scope = yield* Scope.fork(rootScope)
          // A bind failure (port in use, sandbox) is not fatal: the flow stays
          // completable through the pasted-redirect fallback.
          const callback = yield* AuthOpenAI.callback({ state: flow.state, port: callbackPort }).pipe(
            Scope.provide(scope),
            Effect.catchTag("AuthOpenAI.CallbackPortUnavailableError", () => Effect.succeed(undefined)),
          )
          const id = crypto.randomUUID()
          flows.set(id, {
            providerID,
            verifier: flow.verifier,
            state: flow.state,
            createdAt: Date.now(),
            callback,
            scope,
          })
          return {
            data: {
              flow: id,
              url: AuthOpenAI.authorizeUrl(flow, issuer),
              callback: callback === undefined ? { listening: false } : { listening: true, port: callback.port },
            },
          }
        }),
      )
      .handle(
        "oauthComplete",
        Effect.fn(function* (ctx) {
          const providerID = yield* oauthProvider(ctx.params.provider)
          yield* prune
          const pending = flows.get(ctx.payload.flow)
          if (pending === undefined || pending.providerID !== providerID)
            return yield* Effect.fail(
              new InvalidRequestError({
                message: "Unknown or expired sign-in flow; start the sign-in again.",
                field: "flow",
              }),
            )

          // A denial is terminal for the flow; parse problems (typo, partial
          // paste) keep it alive so the user can paste again.
          const denied = (error: { readonly reason: string }) =>
            discard(ctx.payload.flow, pending).pipe(
              Effect.andThen(
                Effect.fail(new ForbiddenError({ message: `ChatGPT sign-in was denied (${error.reason}).` })),
              ),
            )

          const redirect = ctx.payload.redirect?.trim()
          const code =
            redirect !== undefined && redirect.length > 0
              ? yield* AuthOpenAI.parseRedirect(redirect, pending.state).pipe(
                  Effect.catchTag("AuthOpenAI.RedirectParseError", (error) =>
                    Effect.fail(
                      new InvalidRequestError({
                        message: `Could not use the pasted redirect URL (${error.reason}). Paste the full URL from the browser address bar.`,
                        field: "redirect",
                      }),
                    ),
                  ),
                  Effect.catchTag("AuthOpenAI.AuthorizationDeniedError", denied),
                )
              : pending.callback !== undefined
                ? yield* pending.callback.result.pipe(
                    Effect.timeoutOrElse({
                      duration: Duration.millis(waitMs),
                      orElse: () =>
                        Effect.fail(
                          new InvalidRequestError({
                            message: "Timed out waiting for the browser sign-in; paste the redirect URL instead.",
                            field: "redirect",
                          }),
                        ),
                    }),
                    Effect.catchTag("AuthOpenAI.AuthorizationDeniedError", denied),
                  )
                : yield* Effect.fail(
                    new InvalidRequestError({
                      message:
                        "No callback listener is active for this flow; paste the redirect URL from the browser instead.",
                      field: "redirect",
                    }),
                  )

          // Authorization codes are single-use: the flow is finished (and its
          // listener stopped) whether or not the exchange succeeds.
          const profile = yield* AuthOpenAI.exchange({ code: code.code, verifier: pending.verifier, issuer }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.onExit(() => discard(ctx.payload.flow, pending)),
            Effect.catchTag("AuthOpenAI.TokenExchangeError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `ChatGPT token exchange failed (${error.reason}). Start the sign-in again.`,
                  service: "openai-oauth",
                }),
              ),
            ),
          )
          yield* store.set(providerID, profile).pipe(Effect.catch(storeFailure("write")))
          return { data: yield* statusFor(providerID) }
        }),
      )
  }),
)
