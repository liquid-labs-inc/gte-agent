export * as AuthSchema from "./schema"

import { Schema } from "effect"
import { Provider } from "../provider"

export const ApiKeyProfile = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.String,
})
export type ApiKeyProfile = typeof ApiKeyProfile.Type

/**
 * OAuth-shaped credential. `refresh: ""` together with `expires: 0` marks a
 * long-lived bearer token that cannot be refreshed (e.g. an Anthropic
 * setup-token); such profiles never count as expired.
 */
export const OAuthProfile = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Finite,
  accountId: Schema.optional(Schema.String),
})
export type OAuthProfile = typeof OAuthProfile.Type

export const Profile = Schema.Union([ApiKeyProfile, OAuthProfile]).pipe(Schema.toTaggedUnion("type"))
export type Profile = typeof Profile.Type

export const File = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Record(Schema.String, Profile),
})
export type File = typeof File.Type

export const empty: File = { version: 1, profiles: {} }

/** Single `:default` profile per provider in this milestone; re-authing overwrites it. */
export const profileKey = (providerID: Provider.ID) => `${providerID}:default`
