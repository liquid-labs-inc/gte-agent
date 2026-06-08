export * as GTEAuth from "./gte-auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Schema } from "effect"
import { withStatics } from "./schema"

export const PrincipalID = Schema.String.pipe(Schema.brand("GTEPrincipalID"))
export type PrincipalID = typeof PrincipalID.Type

export const AuthorityID = Schema.String.pipe(
  Schema.brand("GTEAuthorityID"),
  withStatics((schema) => ({
    dev: schema.make("dev_authority"),
  })),
)
export type AuthorityID = typeof AuthorityID.Type

export const DEV_PRINCIPAL_ID = PrincipalID.make("dev_principal")
export const DEV_AUTHORITY_ID = AuthorityID.dev

export const Mode = Schema.Literals(["disabled", "bearer"])
export type Mode = typeof Mode.Type

export type AuthorityAccess = {
  readonly authorityID: AuthorityID
  readonly read: boolean
  readonly act: boolean
}

export type RequestContext = {
  readonly principalID: PrincipalID
  readonly authorities: readonly AuthorityAccess[]
  readonly authDisabled: boolean
}

export type Config = {
  readonly mode: Mode
  readonly token?: string
  readonly principalID: PrincipalID
  readonly authorities: readonly AuthorityID[]
}

export class MissingCredentialsError extends Schema.TaggedErrorClass<MissingCredentialsError>()(
  "GTEAuth.MissingCredentialsError",
  { message: Schema.String },
) {}

export class InvalidCredentialsError extends Schema.TaggedErrorClass<InvalidCredentialsError>()(
  "GTEAuth.InvalidCredentialsError",
  { message: Schema.String },
) {}

export class AuthorityRequiredError extends Schema.TaggedErrorClass<AuthorityRequiredError>()(
  "GTEAuth.AuthorityRequiredError",
  { message: Schema.String },
) {}

export class ReadDeniedError extends Schema.TaggedErrorClass<ReadDeniedError>()("GTEAuth.ReadDeniedError", {
  sessionID: Schema.String,
  principalID: PrincipalID,
  authorityID: AuthorityID,
}) {}

export class MutationDeniedError extends Schema.TaggedErrorClass<MutationDeniedError>()("GTEAuth.MutationDeniedError", {
  sessionID: Schema.String,
  principalID: PrincipalID,
  authorityID: AuthorityID,
}) {}

export class AuthorityConflictError extends Schema.TaggedErrorClass<AuthorityConflictError>()(
  "GTEAuth.AuthorityConflictError",
  {
    sessionID: Schema.String,
    principalID: PrincipalID,
    authorityID: AuthorityID,
  },
) {}

export type AuthError = MissingCredentialsError | InvalidCredentialsError | AuthorityRequiredError
export type AuthorizationError = ReadDeniedError | MutationDeniedError | AuthorityConflictError

export class ConfigService extends Context.Service<ConfigService, Config>()("@gte-agent/AuthConfig") {
  static layer(input: Config) {
    return Layer.succeed(this, this.of(input))
  }

  static get defaultLayer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const mode = yield* EffectConfig.string("GTE_AGENT_AUTH_MODE").pipe(
          EffectConfig.withDefault("disabled"),
          Effect.map((value) => (value === "bearer" ? "bearer" : "disabled") as Mode),
        )
        const authorities = (yield* EffectConfig.string("GTE_AGENT_AUTHORITY_IDS").pipe(
          EffectConfig.withDefault(DEV_AUTHORITY_ID),
        ))
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .map((item) => AuthorityID.make(item))
        return ConfigService.of({
          mode,
          token: Option.getOrUndefined(yield* EffectConfig.string("GTE_AGENT_AUTH_TOKEN").pipe(EffectConfig.option)),
          principalID: PrincipalID.make(
            yield* EffectConfig.string("GTE_AGENT_PRINCIPAL_ID").pipe(EffectConfig.withDefault(DEV_PRINCIPAL_ID)),
          ),
          authorities: authorities.length > 0 ? authorities : [DEV_AUTHORITY_ID],
        })
      }),
    )
  }
}

export class RequestContextService extends Context.Service<RequestContextService, RequestContext>()(
  "@gte-agent/AuthRequestContext",
) {
  static layer(input: RequestContext) {
    return Layer.succeed(this, this.of(input))
  }
}

export const devContext = RequestContextService.of({
  principalID: DEV_PRINCIPAL_ID,
  authorities: [{ authorityID: DEV_AUTHORITY_ID, read: true, act: true }],
  authDisabled: true,
})

export function contextFromConfig(config: Config) {
  return RequestContextService.of({
    principalID: config.principalID,
    authorities: config.authorities.map((authorityID) => ({ authorityID, read: true, act: true })),
    authDisabled: config.mode === "disabled",
  })
}

export function authenticate(
  config: Config,
  authorization: string | undefined,
): Effect.Effect<RequestContext, AuthError> {
  if (config.mode === "disabled") return Effect.succeed(contextFromConfig(config))
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "")
  if (!match) return Effect.fail(new MissingCredentialsError({ message: "GTE bearer credentials are required" }))
  if (config.token && match[1] !== config.token) {
    return Effect.fail(new InvalidCredentialsError({ message: "Invalid GTE bearer token" }))
  }
  if (!config.token && !match[1].startsWith("mock:")) {
    return Effect.fail(new InvalidCredentialsError({ message: "Invalid GTE bearer token" }))
  }
  return Effect.succeed(contextFromConfig(config))
}

export function requireExplicitAuthority(context: RequestContext, authorityID?: AuthorityID) {
  if (authorityID) return Effect.succeed(authorityID)
  if (context.authDisabled) return Effect.succeed(DEV_AUTHORITY_ID)
  return Effect.fail(new AuthorityRequiredError({ message: "authorityID is required when GTE auth is enabled" }))
}

export function canRead(context: RequestContext, authorityID: AuthorityID) {
  return context.authorities.some((authority) => authority.authorityID === authorityID && authority.read)
}

export function canAct(context: RequestContext, authorityID: AuthorityID) {
  return context.authorities.some((authority) => authority.authorityID === authorityID && authority.act)
}

export const defaultLayer = Layer.mergeAll(ConfigService.defaultLayer, RequestContextService.layer(devContext))
