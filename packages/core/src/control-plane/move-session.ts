export * as MoveSession from "./move-session"

import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "../project"
import { Session } from "../session"
import { SessionSchema } from "../session/schema"
import { AbsolutePath } from "../schema"
import { GTEAuth } from "../gte-auth"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: Project.ID,
    actual: Project.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "MoveSession.OperationUnavailableError",
  { operation: Schema.Literal("moveSession") },
) {}

export type Error =
  | Session.NotFoundError
  | GTEAuth.ReadDeniedError
  | OperationUnavailableError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/ControlPlaneMoveSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      yield* session.get(input.sessionID)
      return yield* new OperationUnavailableError({ operation: "moveSession" })
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Project.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
