export * as SessionSchema from "./schema"

import { Schema, SchemaGetter } from "effect"
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

/**
 * Canonical EVM address tracked by a session. Accepts mixed-case input and
 * normalizes to lowercase so persisted values compare bytewise.
 */
export const TrackedAddress = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/))
  .pipe(
    Schema.decode({
      decode: SchemaGetter.transform((address: string) => address.toLowerCase()),
      encode: SchemaGetter.transform((address: string) => address.toLowerCase()),
    }),
    Schema.brand("TrackedAddress"),
  )
  // Type-side guard: `make` must reject non-normalized values, otherwise a live
  // projection could persist mixed case while the durable event stores lowercase.
  .check(Schema.isPattern(/^0x[0-9a-f]{40}$/))
export type TrackedAddress = typeof TrackedAddress.Type

/**
 * Data panels the TUI can pin to a session. Milestone 4 persists the intent;
 * Milestone 5 renders the panels.
 */
export const PanelType = Schema.Literals([
  "book",
  "trades",
  "candles",
  "marketData",
  "positions",
  "openOrders",
  "orders",
  "orderHistory",
  "balances",
  "funding",
  "twapHistory",
  "leverage",
  "accountMetrics",
  "liquidations",
  "benchMetrics",
])
export type PanelType = typeof PanelType.Type

export const PinnedPanel = Schema.Struct({
  panel: PanelType,
  key: Schema.String,
}).annotate({ identifier: "Session.PinnedPanel" })
export type PinnedPanel = typeof PinnedPanel.Type

export const MAX_PINNED_PANELS = 8

export const PinnedPanels = Schema.Array(PinnedPanel).check(Schema.isMaxLength(MAX_PINNED_PANELS))
export type PinnedPanels = typeof PinnedPanels.Type

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
  selectedMarket: Schema.String.pipe(Schema.optional),
  trackedAddress: TrackedAddress.pipe(Schema.optional),
  pinnedPanels: PinnedPanels.pipe(Schema.optional),
}) {}
