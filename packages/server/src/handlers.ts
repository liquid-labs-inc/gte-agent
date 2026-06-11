import { Session } from "@gte-agent/core/session"
import { Layer } from "effect"
import { messageHandlers } from "./handlers/message"
import { sessionHandlers } from "./handlers/session"
import { sessionSnapshotHandlers } from "./handlers/session-snapshot"
import { healthHandlers } from "./handlers/health"
import { gteDataHandlers } from "./handlers/gte-data"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { GtePanelManager } from "@gte-agent/core/gte-data/panel-manager"
import { GteStreams } from "@gte-agent/core/gte-data/streams"
import { SessionSnapshot } from "@gte-agent/core/session/snapshot"
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

// An invalid GTE_AGENT_GTE_ENV fails server startup with a clear ConfigError
// listing the valid environment names (owned by the gte-ts GteEnvKey type).
const gteData = GteData.defaultLayer.pipe(Layer.orDie)

// Layer references shared with `routedSessions` (Event.layer, Database,
// SessionStore) are memoized per runtime build, so the panel manager, the
// snapshot service, and the SSE handler all observe the same event bus and
// database as the session service.
const gteStreams = GteStreams.layer.pipe(Layer.provide(GteData.ConfigService.defaultLayer), Layer.orDie)
const panelManager = GtePanelManager.layer.pipe(
  Layer.provide(gteStreams),
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.orDie,
)
const sessionSnapshots = SessionSnapshot.layer.pipe(
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(GTEAuth.defaultLayer),
  Layer.orDie,
)
const handlerEvents = Event.layer.pipe(Layer.provide(Database.defaultLayer), Layer.orDie)

export const gteAgentHandlers = Layer.mergeAll(
  healthHandlers,
  sessionHandlers,
  sessionSnapshotHandlers.pipe(Layer.provide(sessionSnapshots)),
  messageHandlers,
  gteDataHandlers.pipe(Layer.provide(gteData)),
).pipe(Layer.provide(routedSessions), Layer.provide(panelManager), Layer.provide(handlerEvents))
