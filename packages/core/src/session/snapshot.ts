export * as SessionSnapshot from "./snapshot"

import { Context, DateTime, Effect, Layer, Option } from "effect"
import { Event } from "../event"
import { GTEAuth } from "../gte-auth"
import { NotFoundError } from "../session"
import { SessionEvent } from "./event"
import type { SessionSchema } from "./schema"
import { SessionStore } from "./store"

/**
 * Records compact one-shot data snapshots into the durable session transcript
 * (`session.snapshot.recorded`). Ownership checks mirror
 * `Session.updateIntent`: the principal must be able to read AND act for the
 * session's authority. Continuous panel updates never call this — only
 * explicit one-shot reads (slash commands / tools).
 */

export type RecordInput = {
  readonly sessionID: SessionSchema.ID
  readonly command: string
  readonly panel?: SessionSchema.PanelType
  readonly key?: string
  readonly summary: SessionEvent.SnapshotSummary
  readonly provenance: SessionEvent.SnapshotProvenance
}

export type Recorded = {
  readonly sessionID: SessionSchema.ID
  readonly command: string
  readonly panel?: SessionSchema.PanelType
  readonly key?: string
  /** Durable aggregate sequence assigned to the recorded event. */
  readonly seq?: number
}

export interface Interface {
  readonly record: (
    input: RecordInput,
  ) => Effect.Effect<Recorded, NotFoundError | GTEAuth.ReadDeniedError | GTEAuth.MutationDeniedError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/SessionSnapshot") {}

export const layer: Layer.Layer<Service, never, Event.Service | SessionStore.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* Event.Service
    const store = yield* SessionStore.Service
    const auth = Option.getOrElse(yield* Effect.serviceOption(GTEAuth.RequestContextService), () => GTEAuth.devContext)

    return Service.of({
      record: Effect.fn("SessionSnapshot.record")(function* (input) {
        const session = yield* store.get(input.sessionID)
        if (!session) return yield* new NotFoundError({ sessionID: input.sessionID })
        if (!GTEAuth.canRead(auth, session.authorityID)) {
          return yield* new GTEAuth.ReadDeniedError({
            sessionID: input.sessionID,
            principalID: auth.principalID,
            authorityID: session.authorityID,
          })
        }
        if (!GTEAuth.canAct(auth, session.authorityID)) {
          return yield* new GTEAuth.MutationDeniedError({
            sessionID: input.sessionID,
            principalID: auth.principalID,
            authorityID: session.authorityID,
          })
        }
        const published = yield* events.publish(SessionEvent.SnapshotRecorded, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          command: input.command,
          ...(input.panel === undefined ? {} : { panel: input.panel }),
          ...(input.key === undefined ? {} : { key: input.key }),
          summary: input.summary,
          provenance: input.provenance,
        })
        return {
          sessionID: input.sessionID,
          command: input.command,
          ...(input.panel === undefined ? {} : { panel: input.panel }),
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(published.seq === undefined ? {} : { seq: published.seq }),
        }
      }),
    })
  }),
)
