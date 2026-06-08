import { Effect, Layer } from "effect"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for local sessions. Future clustered placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const coordinator = yield* SessionRunCoordinator.Service
    const scope = yield* Effect.scope
    const withCoordinator = Effect.fnUntraced(function* <A, E>(
      sessionID: SessionSchema.ID,
      use: (coordinator: SessionRunCoordinator.Interface) => Effect.Effect<A, E>,
    ) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return yield* use(coordinator)
    })

    return SessionExecution.Service.of({
      resume: Effect.fn("SessionExecution.resume")(function* (sessionID) {
        return yield* withCoordinator(sessionID, (coordinator) => coordinator.run(sessionID))
      }),
      wake: Effect.fn("SessionExecution.wake")(function* (sessionID) {
        yield* withCoordinator(sessionID, (coordinator) =>
          coordinator.wake(sessionID).pipe(Effect.andThen(coordinator.awaitIdle(sessionID))),
        ).pipe(Effect.forkIn(scope), Effect.asVoid)
      }),
    })
  }),
)
