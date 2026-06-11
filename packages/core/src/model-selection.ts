export * as ModelSelection from "./model-selection"

import path from "path"
import { parse } from "jsonc-parser"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { AuthStore } from "./auth/store"
import { Catalog } from "./catalog"
import { Event } from "./event"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Model } from "./model"
import { Provider } from "./provider"
import { SessionEvent } from "./session/event"
import { SessionMessageID } from "./session/message-id"
import { SessionSchema } from "./session/schema"
import { Flock } from "./util/flock"

/**
 * Model selection surface for the `/models` flow (Milestone 7).
 *
 * Lists catalog models annotated with per-provider auth status (never secret
 * material) and applies a selection: the chosen model is persisted on the
 * session (durable `session.next.model.switched` event) and written as the
 * global default in `~/.gte-agent/config.json` so new sessions inherit it.
 * Selection is strict — a ref that is not in the catalog is a typed error,
 * never a silent fallback.
 */

export type AuthMethod = "api_key" | "oauth"

export type AuthStatus = {
  readonly authenticated: boolean
  readonly method?: AuthMethod
  readonly source?: AuthStore.CredentialSource
}

export type Entry = {
  readonly model: Model.Info
  readonly auth: AuthStatus
  /** True when this model is the persisted global default. */
  readonly isDefault: boolean
}

export type SelectInput = {
  /** When given, the selection is persisted on the session as a durable model switch. */
  readonly sessionID?: SessionSchema.ID
  readonly providerID: Provider.ID
  readonly modelID: Model.ID
  readonly variant?: Model.VariantID
}

export type SelectError = Catalog.ProviderNotFoundError | Catalog.ModelNotFoundError | FSUtil.Error

export interface Interface {
  /** Catalog models (newest first) with the provider's auth status and the global-default marker. */
  readonly list: () => Effect.Effect<Entry[], AuthStore.Error>
  /** Per-provider auth status without secret material. */
  readonly authStatus: (providerID: Provider.ID) => Effect.Effect<AuthStatus, AuthStore.Error>
  /** Global default model ref persisted in `~/.gte-agent/config.json`, when one is set. */
  readonly defaultRef: () => Effect.Effect<Model.Ref | undefined>
  /** Validates against the catalog, persists the session switch, and writes the global default. */
  readonly select: (input: SelectInput) => Effect.Effect<Model.Info, SelectError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/ModelSelection") {}

/** The slice of `~/.gte-agent/config.json` this service owns. Other keys are preserved verbatim. */
const GlobalConfig = Schema.Struct({
  model: Schema.String.pipe(Schema.optional),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const auth = yield* AuthStore.Service
    const events = yield* Event.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const file = path.join(global.home, ".gte-agent", "config.json")
    const lockKey = `config:${file}`

    // Tolerant read: the file is user-editable JSONC. Unknown keys survive a
    // rewrite; comments do not (the global default is machine-managed state).
    const readRaw = Effect.fnUntraced(function* () {
      const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) return {}
      const parsed: unknown = parse(text, [], { allowTrailingComma: true })
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    })

    const defaultRef = Effect.fn("ModelSelection.defaultRef")(function* () {
      const raw = yield* readRaw()
      const decoded = Schema.decodeUnknownOption(GlobalConfig, { onExcessProperty: "ignore" })(raw)
      const model = Option.getOrUndefined(decoded)?.model
      if (model === undefined || !model.includes("/")) return undefined
      const ref = Model.parse(model)
      return { id: ref.modelID, providerID: ref.providerID }
    })

    // Atomic rewrite under a cross-process lock so concurrent selections (or
    // other writers of this file) never interleave partial contents.
    const writeDefault = Effect.fn("ModelSelection.writeDefault")(function* (ref: {
      providerID: Provider.ID
      modelID: Model.ID
    }) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          const raw = yield* readRaw()
          const tempfile = `${file}.${process.pid}.${Date.now()}.tmp`
          yield* fs.ensureDir(path.dirname(file))
          yield* fs
            .writeFileString(tempfile, JSON.stringify({ ...raw, model: `${ref.providerID}/${ref.modelID}` }, null, 2))
            .pipe(
              Effect.andThen(fs.rename(tempfile, file)),
              Effect.onError(() => fs.remove(tempfile, { force: true }).pipe(Effect.ignore)),
            )
        }),
      )
    })

    const authStatus = Effect.fn("ModelSelection.authStatus")(function* (providerID: Provider.ID) {
      const provider = Option.getOrUndefined(yield* catalog.provider.get(providerID).pipe(Effect.option))
      const env =
        provider !== undefined && provider.enabled !== false && provider.enabled.via === "env"
          ? [provider.enabled.name]
          : undefined
      return yield* auth.resolve({ providerID, ...(env === undefined ? {} : { env }) }).pipe(
        Effect.map(
          (credential): AuthStatus => ({ authenticated: true, method: credential.type, source: credential.source }),
        ),
        Effect.catchTag("AuthStore.MissingCredentialsError", () => Effect.succeed({ authenticated: false })),
      )
    })

    return Service.of({
      authStatus,
      defaultRef,
      list: Effect.fn("ModelSelection.list")(function* () {
        const models = yield* catalog.model.available()
        const fallback = yield* defaultRef()
        const statuses = new Map<Provider.ID, AuthStatus>()
        for (const providerID of new Set(models.map((model) => model.providerID))) {
          statuses.set(providerID, yield* authStatus(providerID))
        }
        return models.map((model) => ({
          model,
          auth: statuses.get(model.providerID) ?? { authenticated: false },
          isDefault: fallback !== undefined && fallback.providerID === model.providerID && fallback.id === model.id,
        }))
      }),
      select: Effect.fn("ModelSelection.select")(function* (input) {
        const model = yield* catalog.model.get(input.providerID, input.modelID)
        if (input.sessionID !== undefined) {
          yield* events.publish(SessionEvent.ModelSwitched, {
            sessionID: input.sessionID,
            messageID: SessionMessageID.ID.create(),
            timestamp: yield* DateTime.now,
            model: {
              id: input.modelID,
              providerID: input.providerID,
              ...(input.variant === undefined ? {} : { variant: input.variant }),
            },
          })
        }
        // Every explicit selection becomes the global default for new sessions.
        yield* writeDefault({ providerID: input.providerID, modelID: input.modelID })
        return model
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.defaultLayer))
