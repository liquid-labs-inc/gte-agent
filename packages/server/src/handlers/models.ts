import { Model } from "@gte-agent/core/model"
import { ModelSelection } from "@gte-agent/core/model-selection"
import { Provider } from "@gte-agent/core/provider"
import { Session } from "@gte-agent/core/session"
import { Catalog } from "@gte-agent/core/catalog"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"
import { ModelNotFoundError } from "../groups/models"
import { ForbiddenError, ProviderNotFoundError, SessionNotFoundError, UnknownError } from "../errors"

export const modelsHandlers = HttpApiBuilder.group(GTEAgentApi, "models", (handlers) =>
  Effect.gen(function* () {
    const selection = yield* ModelSelection.Service
    const catalog = yield* Catalog.Service
    const session = yield* Session.Service

    // Store/config failures must not leak file contents or paths (auth.json is
    // secret material) into the response: log a ref + the error tag, return an
    // opaque 500. Mirrors handlers/auth-provider.ts.
    const storeFailure = (operation: string) => (error: { readonly _tag: string }) => {
      const ref = `err_${crypto.randomUUID().slice(0, 8)}`
      return Effect.logError("model selection operation failed").pipe(
        Effect.annotateLogs({ ref, operation, error: error._tag }),
        Effect.andThen(
          Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref })),
        ),
      )
    }

    // Session refs are validated before any selection side effect so an
    // unknown session never writes the global default.
    const sessionInfo = Effect.fn("models.sessionInfo")(function* (sessionID: Session.ID) {
      return yield* session.get(sessionID).pipe(
        Effect.catchTag("Session.NotFoundError", (error) =>
          Effect.fail(
            new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` }),
          ),
        ),
        Effect.catchTag("GTEAuth.ReadDeniedError", (error) =>
          Effect.fail(
            new ForbiddenError({
              message: `Principal ${error.principalID} cannot read authority ${error.authorityID}`,
            }),
          ),
        ),
      )
    })

    return handlers
      .handle(
        "list",
        Effect.fn(function* (ctx) {
          const current = ctx.query.sessionID === undefined ? undefined : yield* sessionInfo(ctx.query.sessionID)
          const entries = yield* selection.list().pipe(Effect.catch(storeFailure("list")))
          const fallback = yield* selection.defaultRef()
          // Group in the catalog's provider order; entries are newest first
          // within each provider (ModelSelection.list preserves catalog order).
          const providers = (yield* catalog.provider.available())
            .map((provider) => {
              const rows = entries.filter((entry) => entry.model.providerID === provider.id)
              return {
                id: provider.id,
                name: provider.name,
                // list() resolves one auth status per provider, so any row carries it.
                auth: rows[0]?.auth ?? { authenticated: false },
                models: rows.map((entry) => ({
                  id: entry.model.id,
                  name: entry.model.name,
                  family: entry.model.family,
                  status: entry.model.status,
                  released: DateTime.toEpochMillis(entry.model.time.released),
                  capabilities: { tools: entry.model.capabilities.tools },
                  limit: { context: entry.model.limit.context, output: entry.model.limit.output },
                  variants: entry.model.variants.map((variant) => variant.id),
                  isDefault: entry.isDefault,
                })),
              }
            })
            .filter((provider) => provider.models.length > 0)
          return {
            data: {
              providers,
              default: fallback,
              session: current === undefined ? undefined : { id: current.id, model: current.model },
            },
          }
        }),
      )
      .handle(
        "select",
        Effect.fn(function* (ctx) {
          const providerID = Provider.ID.make(ctx.payload.providerID)
          const modelID = Model.ID.make(ctx.payload.modelID)
          if (ctx.payload.sessionID !== undefined) yield* sessionInfo(ctx.payload.sessionID)
          const model = yield* selection
            .select({
              providerID,
              modelID,
              ...(ctx.payload.variant === undefined ? {} : { variant: Model.VariantID.make(ctx.payload.variant) }),
              ...(ctx.payload.sessionID === undefined ? {} : { sessionID: ctx.payload.sessionID }),
            })
            .pipe(
              Effect.catchTag("Catalog.ProviderNotFound", (error) =>
                Effect.fail(
                  new ProviderNotFoundError({
                    providerID: error.providerID,
                    message: `Unknown LLM provider: ${error.providerID}`,
                  }),
                ),
              ),
              Effect.catchTag("Catalog.ModelNotFound", (error) =>
                Effect.fail(
                  new ModelNotFoundError({
                    providerID: error.providerID,
                    modelID: error.modelID,
                    message: `Unknown model: ${error.providerID}/${error.modelID}`,
                  }),
                ),
              ),
              // FSUtil.Error (the global-default write) is PlatformError | FileSystemError.
              Effect.catchTag("PlatformError", storeFailure("select")),
              Effect.catchTag("FileSystemError", storeFailure("select")),
            )
          return {
            data: {
              model: {
                id: model.id,
                providerID: model.providerID,
                variant: ctx.payload.variant === undefined ? undefined : Model.VariantID.make(ctx.payload.variant),
              },
              name: model.name,
              // The selection itself never requires credentials: the client
              // uses this status to chain into the auth wizard when needed.
              auth: yield* selection.authStatus(providerID).pipe(Effect.catch(storeFailure("status"))),
            },
          }
        }),
      )
  }),
)
