export * as SessionSchema from "./schema"

import { Schema } from "effect"
import { Model } from "../model"
import { Project } from "../project"
import { externalID, type ExternalID, RelativePath, optionalOmitUndefined, withStatics } from "../schema"
import { Identifier } from "../util/identifier"
import { TimeSchema } from "../time-schema"
import { Agent } from "../agent"
import { GTEAuth } from "../gte-auth"
import { RuntimeScope } from "../runtime-scope"

export const ID = Schema.String.check(Schema.isStartsWith("ses")).pipe(
  Schema.brand("SessionID"),
  withStatics((schema) => {
    const create = () => schema.make("ses_" + Identifier.descending())
    return {
      create,
      descending: (id?: string) => (id === undefined ? create() : schema.make(id)),
      fromExternal: (input: ExternalID) => schema.make(externalID("ses", input)),
    }
  }),
)
export type ID = typeof ID.Type

export class Info extends Schema.Class<Info>("Session.Info")({
  id: ID,
  parentID: ID.pipe(optionalOmitUndefined),
  projectID: Project.ID,
  principalID: GTEAuth.PrincipalID,
  authorityID: GTEAuth.AuthorityID,
  agent: Agent.ID.pipe(Schema.optional),
  model: Model.Ref.pipe(Schema.optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: TimeSchema.DateTimeUtcFromMillis,
    updated: TimeSchema.DateTimeUtcFromMillis,
    archived: TimeSchema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
  title: Schema.String,
  runtimeScope: RuntimeScope.Ref,
  subpath: RelativePath.pipe(Schema.optional),
}) {}
