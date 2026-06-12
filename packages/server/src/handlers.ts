import { Session } from "@gte-agent/core/session"
import { Effect, Layer } from "effect"
import { authProviderHandlers } from "./handlers/auth-provider"
import { modelsHandlers } from "./handlers/models"
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
import { SessionRunnerDefault } from "@gte-agent/core/session/runner/default"
import { SessionStore } from "@gte-agent/core/session/store"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { AuthStore } from "@gte-agent/core/auth/store"
import { Catalog } from "@gte-agent/core/catalog"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { ModelSelection } from "@gte-agent/core/model-selection"
import { Permission } from "@gte-agent/core/permission"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { SystemContextBuiltIns } from "@gte-agent/core/system-context-builtins"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { GteTools } from "@gte-agent/core/tool/gte/tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"

// An invalid GTE_AGENT_GTE_ENV fails server startup with a clear ConfigError
// listing the valid environment names (owned by the gte-ts GteEnvKey type).
const gteData = GteData.defaultLayer.pipe(Layer.orDie)

// Process-global synthetic runtime scope rooted at the server's working
// directory. The catalog is curated and static and the runner resolves models
// per session through the store, so one scope serves the whole daemon.
const runtimeScope = RuntimeScope.Service.layer(RuntimeScope.fromRef({ directory: AbsolutePath.make(process.cwd()) }))

const handlerEvents = Event.layer.pipe(Layer.provide(Database.defaultLayer), Layer.orDie)

// Curated model catalog shared by the /models routes and the session runner
// (same layer reference, so the runtime memoizes a single Catalog instance).
// `handlerEvents` shares the memoized Event/Database layers with
// `routedSessions`, so durable model-switch events published by a selection
// land on the same bus and database the session projector observes.
const modelCatalog = Catalog.runtimeScopeLayer.pipe(
  Layer.provide(runtimeScope),
  Layer.provide(handlerEvents),
  Layer.orDie,
)

// Phase 1 has no interactive permission surface and the advertised tools are
// read-only, so the runner's tool registry gets the same allow-all permission
// stub as the core runtime-scope composition (core/src/runtime-scope-layer.ts).
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: (input) => Effect.fail(new Permission.NotFoundError({ requestID: input.requestID })),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    forSession: () => Effect.succeed([]),
  }),
)

const toolRegistry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))

// Read-only gte_* tools registered against the runner's registry, bound to the
// same GteData service the data routes use. SessionStore is provided so the
// session tracked-address fallback is active for address-scoped tools.
const gteTools = GteTools.layer.pipe(
  Layer.provide(toolRegistry),
  Layer.provide(gteData),
  Layer.provide(SessionStore.layer),
  Layer.provide(Database.defaultLayer),
  Layer.orDie,
)

// Production session runner (checklist item 7): the deterministic demo client
// survives only behind GTE_AGENT_LLM=demo; the default path resolves the
// session's model through the curated catalog and ~/.gte-agent/auth.json and
// streams real provider turns with the GTE system prompt and the read-only
// tool registry. `gteData` feeds the system prompt's GTE-environment line.
const sessionRunner = SessionRunnerDefault.layer.pipe(
  Layer.provide(Layer.mergeAll(toolRegistry, gteTools, modelCatalog, SystemContextBuiltIns.layer, gteData)),
  Layer.provide(runtimeScope),
  Layer.provide(SessionStore.layer),
  Layer.provide(handlerEvents),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
  Layer.orDie,
)

const routedSessions = Session.layer.pipe(
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionExecutionLocal.layer),
  Layer.provide(SessionRunCoordinator.layer),
  Layer.provide(sessionRunner),
  Layer.provide(GTEAuth.defaultLayer),
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.orDie,
)

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
// LLM provider credentials (~/.gte-agent/auth.json). The auth-provider handlers
// also need an HttpClient (token exchange), provided in routes.ts.
const authStore = AuthStore.defaultLayer.pipe(Layer.orDie)

// Model selection for the /models routes, over the shared curated catalog.
const modelSelection = ModelSelection.defaultLayer.pipe(
  Layer.provideMerge(modelCatalog),
  Layer.provide(authStore),
  Layer.provide(handlerEvents),
  Layer.orDie,
)

export const gteAgentHandlers = Layer.mergeAll(
  healthHandlers,
  sessionHandlers,
  sessionSnapshotHandlers.pipe(Layer.provide(sessionSnapshots)),
  messageHandlers,
  gteDataHandlers.pipe(Layer.provide(gteData)),
  authProviderHandlers.pipe(Layer.provide(authStore)),
  modelsHandlers.pipe(Layer.provide(modelSelection)),
).pipe(Layer.provide(routedSessions), Layer.provide(panelManager), Layer.provide(handlerEvents))
