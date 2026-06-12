import { Model } from "@gte-agent/core/model"
import { Session } from "@gte-agent/core/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, ProviderNotFoundError, SessionNotFoundError, UnknownError } from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

/**
 * Model catalog and selection routes for the `/models` flow (Milestone 7).
 *
 * The listing is the curated, static, GTE-owned catalog grouped by provider,
 * each provider annotated with its credential status (method and source only —
 * responses NEVER carry secret material). Selection is strict: a ref that is
 * not in the curated catalog is a typed 404, never a silent fallback.
 */

/** Lives here rather than ../errors.ts because only the models routes raise it. */
export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()(
  "ModelNotFoundError",
  {
    providerID: Schema.String,
    modelID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

/** Selecting a variant the model does not offer; persisting it would brick later turns. */
export class VariantNotFoundError extends Schema.TaggedErrorClass<VariantNotFoundError>()(
  "VariantNotFoundError",
  {
    providerID: Schema.String,
    modelID: Schema.String,
    variant: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const ModelsAuthStatus = Schema.Struct({
  authenticated: Schema.Boolean.annotate({
    description: "True when a usable credential exists for the model's provider.",
  }),
  method: Schema.Literals(["api_key", "oauth"])
    .pipe(Schema.optional)
    .annotate({ description: "Credential kind, when authenticated." }),
  source: Schema.Literals(["config", "store", "env"]).pipe(Schema.optional).annotate({
    description:
      "Where the credential resolves from: explicit per-model config, the ~/.gte-agent/auth.json store, or a provider environment variable.",
  }),
}).annotate({ identifier: "ModelsAuthStatus" })
export type ModelsAuthStatus = typeof ModelsAuthStatus.Type

export const ModelsCatalogModel = Schema.Struct({
  id: Schema.String.annotate({ description: "Model id within the provider (e.g. claude-fable-5)." }),
  name: Schema.String.annotate({ description: "Human-readable model name." }),
  family: Schema.String.pipe(Schema.optional).annotate({ description: "Model family grouping, when known." }),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  released: Schema.Finite.annotate({ description: "Release date as epoch milliseconds." }),
  capabilities: Schema.Struct({
    tools: Schema.Boolean.annotate({ description: "True when the model supports tool calling." }),
  }),
  limit: Schema.Struct({
    context: Schema.Int,
    output: Schema.Int,
  }).annotate({ description: "Token limits (context window and maximum output)." }),
  variants: Schema.Array(Schema.String)
    .pipe(Schema.optional)
    .annotate({
      description: "Reasoning-effort variant ids the model offers (e.g. low/medium/high/xhigh/max), in catalog order.",
    }),
  isDefault: Schema.Boolean.annotate({
    description: "True when this model is the persisted global default in ~/.gte-agent/config.json.",
  }),
}).annotate({ identifier: "ModelsCatalogModel" })
export type ModelsCatalogModel = typeof ModelsCatalogModel.Type

export const ModelsCatalogProvider = Schema.Struct({
  id: Schema.String.annotate({ description: "Provider id (anthropic, openai)." }),
  name: Schema.String.annotate({ description: "Human-readable provider name." }),
  auth: ModelsAuthStatus,
  models: Schema.Array(ModelsCatalogModel).annotate({ description: "Curated models for this provider, newest first." }),
}).annotate({ identifier: "ModelsCatalogProvider" })
export type ModelsCatalogProvider = typeof ModelsCatalogProvider.Type

export const ModelsGroup = HttpApiGroup.make("models")
  .add(
    HttpApiEndpoint.get("list", "/api/models", {
      query: Schema.Struct({
        sessionID: Session.ID.pipe(Schema.optional).annotate({
          description: "When given, the response includes that session's current model selection.",
        }),
      }).annotate({ identifier: "ModelsQuery" }),
      success: Schema.Struct({
        data: Schema.Struct({
          providers: Schema.Array(ModelsCatalogProvider),
          default: Model.Ref.pipe(Schema.optional).annotate({
            description: "The persisted global default model, when one is set.",
          }),
          session: Schema.Struct({
            id: Session.ID,
            model: Model.Ref.pipe(Schema.optional).annotate({
              description: "The session's current model selection, when one is recorded.",
            }),
          })
            .pipe(Schema.optional)
            .annotate({ description: "Present only when the sessionID query parameter was given." }),
        }),
      }).annotate({ identifier: "ModelsListResponse" }),
      error: [ForbiddenError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "models.list",
        summary: "List the curated model catalog",
        description:
          "Curated models grouped by provider, each provider annotated with credential status (method and source only; no secret material), plus the global default and the optional per-session selection.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("select", "/api/models/select", {
      payload: Schema.Struct({
        providerID: Schema.String.annotate({ description: "Provider id (anthropic, openai)." }),
        modelID: Schema.String.annotate({ description: "Model id within the provider." }),
        variant: Schema.String.pipe(Schema.optional).annotate({ description: "Optional model variant id." }),
        sessionID: Session.ID.pipe(Schema.optional).annotate({
          description: "When given, the selection is also persisted on this session as a durable model switch.",
        }),
      }).annotate({ identifier: "ModelsSelectRequest" }),
      success: Schema.Struct({
        data: Schema.Struct({
          model: Model.Ref,
          name: Schema.String,
          auth: ModelsAuthStatus.annotate({
            description:
              "Credential status for the selected model's provider. Selecting an unauthenticated provider succeeds; the client chains into the auth wizard.",
          }),
        }),
      }).annotate({ identifier: "ModelsSelectResponse" }),
      error: [ProviderNotFoundError, ModelNotFoundError, VariantNotFoundError, SessionNotFoundError, ForbiddenError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "models.select",
        summary: "Select a model",
        description:
          "Validates the ref against the curated catalog (strict: unknown refs are typed 404s), persists the switch on the session when sessionID is given, and writes the global default in ~/.gte-agent/config.json so new sessions inherit it.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "models",
      description: "Curated model catalog and model selection. Responses never contain secret material.",
    }),
  )
  .middleware(GTEAuthorization)
