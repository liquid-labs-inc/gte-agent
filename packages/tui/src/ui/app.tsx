import type { KeyEvent } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createMemo, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { AuthStatus } from "../api/auth"
import type { Api, SessionInfo } from "../api/client"
import type { EventSubscriber } from "../api/events"
import type { GteApi } from "../api/gte"
import { executeSlashCommand, parseSlashCommand } from "../commands/slash"
import { applyEvent, isStreaming, seedFromMessages, type TranscriptEntry } from "../state/transcript"
import {
  applyPanelSnapshot,
  applyWorkspaceEvent,
  emptyWorkspace,
  focusPanel,
  isWorkspaceEvent,
  pinnedPanels,
  seedWorkspace,
  type WorkspaceState,
} from "../state/workspace"
import { DataWorkspace } from "./data-workspace"
import { ErrorBanner } from "./error-banner"
import { PromptInput } from "./prompt-input"
import { SessionList } from "./session-list"
import { StatusBar, type ServerStatus } from "./status-bar"
import { theme } from "./theme"
import { TranscriptView } from "./transcript-view"

export type AppProps = {
  api: Api
  gte: GteApi
  subscribe: EventSubscriber
  auth: AuthStatus
  server: ServerStatus
  /** Runtime scope directory used when creating sessions. */
  directory: string
  version: string
  /** HTTP snapshot refresh cadence for degraded panels (default 5s). */
  pollIntervalMs?: number
  onExit: () => void
}

type Store = {
  screen: "sessions" | "session"
  sessions: SessionInfo[]
  loadingSessions: boolean
  session?: SessionInfo
  transcript: TranscriptEntry[]
  loadingTranscript: boolean
  workspace: WorkspaceState
  gteEnv?: string
  error?: string
}

export function App(props: AppProps) {
  const [store, setStore] = createStore<Store>({
    screen: "sessions",
    sessions: [],
    loadingSessions: true,
    transcript: [],
    loadingTranscript: false,
    workspace: emptyWorkspace,
  })

  let unsubscribe: (() => void) | undefined
  // Bumped on every open/close so async work from a previous navigation
  // (history load, stream subscribe) cannot clobber the current session.
  let openEpoch = 0
  let localEntryID = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  const pollsInFlight = new Set<string>()

  const fail = (error: unknown) =>
    setStore("error", error instanceof Error ? error.message : String(error))

  const pushLocal = (kind: "info", text: string) =>
    setStore("transcript", (entries) => [...entries, { kind, id: `local_${++localEntryID}`, text }])

  async function refreshSessions() {
    setStore("loadingSessions", true)
    try {
      const sessions = await props.api.listSessions()
      setStore("sessions", sessions)
    } catch (error) {
      fail(error)
    } finally {
      setStore("loadingSessions", false)
    }
  }

  function closeStream() {
    unsubscribe?.()
    unsubscribe = undefined
  }

  function stopPolling() {
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
    pollsInFlight.clear()
  }

  /**
   * HTTP snapshot fallback: refresh degraded panels every pollIntervalMs.
   * Panels without a one-shot route (liquidations, bench metrics, leverage)
   * simply stay marked degraded.
   */
  function startPolling(epoch: number) {
    stopPolling()
    pollTimer = setInterval(() => {
      if (epoch !== openEpoch) return
      for (const panel of store.workspace.panels) {
        if (panel.status !== "degraded") continue
        const id = `${panel.panel}:${panel.key}`
        if (pollsInFlight.has(id)) continue
        const fetcher = props.gte.panelSnapshot(panel.panel, panel.key)
        if (fetcher === undefined) continue
        pollsInFlight.add(id)
        fetcher
          .then((snapshot) => {
            if (epoch !== openEpoch) return
            setStore("workspace", (workspace) =>
              applyPanelSnapshot(workspace, panel.panel, panel.key, snapshot.data, snapshot.provenance.timestamp),
            )
          })
          .catch(() => {
            // Snapshot fallback failed too; the panel stays degraded.
          })
          .finally(() => {
            pollsInFlight.delete(id)
          })
      }
    }, props.pollIntervalMs ?? 5_000)
  }

  function openSession(session: SessionInfo) {
    closeStream()
    const epoch = ++openEpoch
    setStore({
      screen: "session",
      session,
      transcript: [],
      loadingTranscript: true,
      workspace: seedWorkspace(session as Record<string, unknown>),
      error: undefined,
    })
    const sessionID = String(session.id)
    void props.api
      .messages(sessionID)
      .then((messages) => {
        if (epoch !== openEpoch) return
        setStore("transcript", seedFromMessages(messages))
      })
      .catch((error: unknown) => {
        if (epoch === openEpoch) fail(error)
      })
      .finally(() => {
        if (epoch !== openEpoch) return
        setStore("loadingTranscript", false)
        // Replay all durable events idempotently over the seeded history, then
        // keep streaming live events. Workspace events (intent + ephemeral
        // panel updates) are routed to the data workspace and never grow the
        // transcript.
        unsubscribe = props.subscribe({
          sessionID,
          onEvent: (envelope) => {
            if (epoch !== openEpoch) return
            if (isWorkspaceEvent(envelope.event.type)) {
              setStore("workspace", (workspace) => applyWorkspaceEvent(workspace, envelope))
              return
            }
            setStore("transcript", (entries) => applyEvent(entries, envelope))
          },
          onError: (error) => {
            if (epoch === openEpoch) fail(error)
          },
        })
        startPolling(epoch)
      })
  }

  function closeSession() {
    closeStream()
    stopPolling()
    openEpoch++
    setStore({
      screen: "sessions",
      session: undefined,
      transcript: [],
      workspace: emptyWorkspace,
      error: undefined,
    })
    void refreshSessions()
  }

  function createSession() {
    props.api
      .createSession({ directory: props.directory })
      .then((session) => {
        setStore("sessions", (sessions) => [session, ...sessions])
        openSession(session)
      })
      .catch(fail)
  }

  function submitPrompt(text: string) {
    const session = store.session
    if (!session) return
    setStore("error", undefined)
    const slash = parseSlashCommand(text)
    if (slash !== undefined) {
      pushLocal("info", text)
      void executeSlashCommand(slash, {
        gte: props.gte,
        sessionID: String(session.id),
        env: store.gteEnv ?? "unknown",
        selectedMarket: store.workspace.selectedMarket,
        trackedAddress: store.workspace.trackedAddress,
        pinnedPanels: pinnedPanels(store.workspace),
        focusPanel: (panel, key) => setStore("workspace", (workspace) => focusPanel(workspace, panel, key)),
        info: (line) => pushLocal("info", line),
        error: (line) => setStore("error", line),
      })
      return
    }
    props.api.prompt(String(session.id), text).catch(fail)
  }

  useKeyboard((event: KeyEvent) => {
    if (event.ctrl && event.name === "c") {
      props.onExit()
      return
    }
    if (event.ctrl && event.name === "n") {
      createSession()
      return
    }
    if (event.name === "escape" && store.screen === "session") {
      closeSession()
    }
  })

  onMount(() => {
    void refreshSessions()
    props.gte
      .env()
      .then((result) => setStore("gteEnv", result.env))
      .catch(() => {
        // GTE env display stays unknown; commands will surface real errors.
      })
  })

  onCleanup(() => {
    closeStream()
    stopPolling()
  })

  const streaming = createMemo(() => isStreaming(store.transcript))

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexShrink={0} paddingLeft={1} paddingRight={1} border={["bottom"]} borderColor={theme.border}>
        <text fg={theme.accent}>GTE Agent</text>
        <text fg={theme.muted}>
          {" "}
          · gta v{props.version}
          {store.session ? ` · ${store.session.title || String(store.session.id)}` : ""}
        </text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" flexGrow={1}>
          <Show
            when={store.screen === "session"}
            fallback={
              <SessionList
                sessions={store.sessions}
                loading={store.loadingSessions}
                onOpen={openSession}
                onCreate={createSession}
              />
            }
          >
            <TranscriptView entries={store.transcript} loading={store.loadingTranscript} />
            <PromptInput onSubmit={submitPrompt} />
            <box flexShrink={0} paddingLeft={1}>
              <text fg={theme.muted}>enter send · /command data · esc sessions · ctrl+n new · ctrl+c quit</text>
            </box>
          </Show>
        </box>
        <DataWorkspace workspace={store.workspace} env={store.gteEnv} />
      </box>
      <ErrorBanner message={store.error} />
      <StatusBar server={props.server} auth={props.auth} session={store.session} streaming={streaming()} />
    </box>
  )
}
