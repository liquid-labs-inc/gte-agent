import { Session } from "@gte-agent/core/session"
import { Layer } from "effect"
import { messageHandlers } from "./handlers/message"
import { sessionHandlers } from "./handlers/session"
import { healthHandlers } from "./handlers/health"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { Project } from "@gte-agent/core/project"
import * as SessionExecutionLocal from "@gte-agent/core/session/execution/local"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import * as SessionRunnerDemo from "@gte-agent/core/session/runner/demo"
import { SessionStore } from "@gte-agent/core/session/store"
import { GTEAuth } from "@gte-agent/core/gte-auth"

const routedSessions = Session.layer.pipe(
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionExecutionLocal.layer),
  Layer.provide(SessionRunCoordinator.layer),
  Layer.provide(SessionRunnerDemo.layer),
  Layer.provide(GTEAuth.defaultLayer),
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.orDie,
)

export const gteAgentHandlers = Layer.mergeAll(
  healthHandlers,
  sessionHandlers,
  messageHandlers,
).pipe(Layer.provide(routedSessions))
