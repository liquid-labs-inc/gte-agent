export * as AuthStore from "./store"

import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Provider } from "../provider"
import { Flock } from "../util/flock"
import { AuthSchema } from "./schema"

export class InvalidAuthFileError extends Schema.TaggedErrorClass<InvalidAuthFileError>()(
  "AuthStore.InvalidAuthFileError",
  { path: Schema.String },
) {}

export class MissingCredentialsError extends Schema.TaggedErrorClass<MissingCredentialsError>()(
  "AuthStore.MissingCredentialsError",
  { providerID: Provider.ID },
) {}

export type Error = InvalidAuthFileError | FSUtil.Error

/** Well-known environment variable fallbacks, consulted after auth.json profiles. */
export const ENV: Record<string, readonly string[]> = {
  [Provider.ID.anthropic]: ["ANTHROPIC_API_KEY"],
  [Provider.ID.openai]: ["OPENAI_API_KEY"],
}

export type CredentialSource = "config" | "store" | "env"

export type Credential =
  | { readonly type: "api_key"; readonly key: string; readonly source: CredentialSource }
  | { readonly type: "oauth"; readonly profile: AuthSchema.OAuthProfile; readonly source: "store" }

export interface ResolveOptions {
  readonly providerID: Provider.ID
  /** Explicit per-model config value (e.g. `model.request.body.apiKey`); wins over the store. */
  readonly explicit?: string
  /** Environment variable names consulted last; defaults to the provider's well-known names. */
  readonly env?: readonly string[]
}

export interface Interface {
  /** Absolute path of the backing auth.json. */
  readonly file: string
  readonly read: () => Effect.Effect<AuthSchema.File, Error>
  readonly get: (providerID: Provider.ID) => Effect.Effect<AuthSchema.Profile | undefined, Error>
  readonly set: (providerID: Provider.ID, profile: AuthSchema.Profile) => Effect.Effect<void, Error>
  readonly remove: (providerID: Provider.ID) => Effect.Effect<void, Error>
  /** Resolution order: explicit per-model config value → auth.json profile → provider env var. */
  readonly resolve: (options: ResolveOptions) => Effect.Effect<Credential, Error | MissingCredentialsError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/AuthStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const file = path.join(global.home, ".gte-agent", "auth.json")
    const lockKey = `auth:${file}`

    const read = Effect.fn("AuthStore.read")(function* () {
      const text = yield* fs.readFileStringSafe(file)
      if (text === undefined) return AuthSchema.empty
      const decoded = Option.flatMap(
        Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text),
        Schema.decodeUnknownOption(AuthSchema.File, { onExcessProperty: "ignore" }),
      )
      // The error carries the path only: file contents are secret material.
      if (Option.isNone(decoded)) return yield* new InvalidAuthFileError({ path: file })
      return decoded.value
    })

    // Atomic rewrite: write a 0600 temp file and rename it over auth.json so
    // readers never observe a partial file and secrets are never world-readable.
    const write = Effect.fn("AuthStore.write")(function* (data: AuthSchema.File) {
      const tempfile = `${file}.${process.pid}.${Date.now()}.tmp`
      yield* fs.ensureDir(path.dirname(file))
      yield* fs.writeFileString(tempfile, JSON.stringify(data, null, 2), { mode: 0o600 }).pipe(
        Effect.andThen(fs.rename(tempfile, file)),
        Effect.onError(() => fs.remove(tempfile, { force: true }).pipe(Effect.ignore)),
      )
    })

    // Flock serializes read-modify-write across processes so a token refresh in
    // one gte-agent process cannot clobber a rotation persisted by another.
    const mutate = (update: (data: AuthSchema.File) => AuthSchema.File) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          yield* write(update(yield* read()))
        }),
      )

    const get = Effect.fn("AuthStore.get")(function* (providerID: Provider.ID) {
      return (yield* read()).profiles[AuthSchema.profileKey(providerID)]
    })

    return Service.of({
      file,
      read,
      get,
      set: (providerID, profile) =>
        mutate((data) => ({ ...data, profiles: { ...data.profiles, [AuthSchema.profileKey(providerID)]: profile } })),
      remove: (providerID) =>
        mutate((data) => {
          const profiles = { ...data.profiles }
          delete profiles[AuthSchema.profileKey(providerID)]
          return { ...data, profiles }
        }),
      resolve: Effect.fn("AuthStore.resolve")(function* (options) {
        if (options.explicit) return { type: "api_key", key: options.explicit, source: "config" } as const
        const profile = yield* get(options.providerID)
        if (profile?.type === "api_key") return { type: "api_key", key: profile.key, source: "store" } as const
        if (profile?.type === "oauth") return { type: "oauth", profile, source: "store" } as const
        const fromEnv = (options.env ?? ENV[options.providerID] ?? [])
          .map((name) => process.env[name])
          .find((value) => value !== undefined && value.length > 0)
        if (fromEnv) return { type: "api_key", key: fromEnv, source: "env" } as const
        return yield* new MissingCredentialsError({ providerID: options.providerID })
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.defaultLayer))
