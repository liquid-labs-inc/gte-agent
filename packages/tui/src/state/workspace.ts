/**
 * Pure data-workspace model.
 *
 * Seeded from durable session intent (selected market, tracked address,
 * pinned panels) and kept current by canonical session events:
 *
 * - "session.intent.updated"  (durable)   reconciles the pinned panel list
 * - "session.panel.updated"   (ephemeral) latest throttled live data per panel
 * - "session.panel.status"    (ephemeral) live / degraded / closed transitions
 *
 * Degraded panels are refreshed by the HTTP snapshot poller via
 * `applyPanelSnapshot` (source "http" + refreshed-at timestamp).
 */
import type { PanelType, PinnedPanel } from "../api/gte"
import type { SessionEventEnvelope } from "../api/events"

export type PanelStatus = "pending" | "live" | "degraded" | "closed"

export type PanelView = {
  readonly panel: PanelType
  readonly key: string
  readonly status: PanelStatus
  /** Transport of the data currently shown. */
  readonly source?: "ws" | "http"
  readonly data?: unknown
  readonly updatedAt?: string
  readonly reason?: string
}

export type WorkspaceState = {
  readonly selectedMarket?: string
  readonly trackedAddress?: string
  readonly panels: readonly PanelView[]
  /** Panel id (`panel:key`) currently focused for detail rendering. */
  readonly focused?: string
}

export const panelID = (panel: string, key: string) => `${panel}:${key}`

export const emptyWorkspace: WorkspaceState = { panels: [] }

export function seedWorkspace(session: {
  selectedMarket?: unknown
  trackedAddress?: unknown
  pinnedPanels?: unknown
}): WorkspaceState {
  const pinned = Array.isArray(session.pinnedPanels) ? (session.pinnedPanels as PinnedPanel[]) : []
  return {
    selectedMarket: typeof session.selectedMarket === "string" ? session.selectedMarket : undefined,
    trackedAddress: typeof session.trackedAddress === "string" ? session.trackedAddress : undefined,
    panels: pinned.map((pin) => ({ panel: pin.panel, key: pin.key, status: "pending" as const })),
    focused: pinned.length > 0 ? panelID(pinned[0].panel, pinned[0].key) : undefined,
  }
}

export function pinnedPanels(state: WorkspaceState): PinnedPanel[] {
  return state.panels.map((panel) => ({ panel: panel.panel, key: panel.key }))
}

export function focusPanel(state: WorkspaceState, panel: PanelType, key: string): WorkspaceState {
  return { ...state, focused: panelID(panel, key) }
}

function reconcilePanels(state: WorkspaceState, pinned: readonly PinnedPanel[]): WorkspaceState {
  const existing = new Map(state.panels.map((panel) => [panelID(panel.panel, panel.key), panel]))
  const panels = pinned.map(
    (pin) => existing.get(panelID(pin.panel, pin.key)) ?? { panel: pin.panel, key: pin.key, status: "pending" as const },
  )
  const ids = new Set(panels.map((panel) => panelID(panel.panel, panel.key)))
  const focused = state.focused !== undefined && ids.has(state.focused) ? state.focused : panels.length > 0 ? panelID(panels[0].panel, panels[0].key) : undefined
  return { ...state, panels, focused }
}

function updatePanel(
  state: WorkspaceState,
  panel: string,
  key: string,
  update: (current: PanelView) => PanelView,
): WorkspaceState {
  const id = panelID(panel, key)
  const index = state.panels.findIndex((current) => panelID(current.panel, current.key) === id)
  if (index < 0) return state
  const panels = [...state.panels]
  panels[index] = update(panels[index])
  return { ...state, panels }
}

/** Returns the state unchanged when the event is not workspace-related. */
export function applyWorkspaceEvent(state: WorkspaceState, envelope: SessionEventEnvelope): WorkspaceState {
  const { type, data } = envelope.event
  switch (type) {
    case "session.intent.updated": {
      const pinned = Array.isArray(data["pinnedPanels"]) ? (data["pinnedPanels"] as PinnedPanel[]) : []
      const next = reconcilePanels(state, pinned)
      return {
        ...next,
        selectedMarket: typeof data["selectedMarket"] === "string" ? data["selectedMarket"] : undefined,
        trackedAddress: typeof data["trackedAddress"] === "string" ? data["trackedAddress"] : undefined,
      }
    }
    case "session.panel.updated": {
      const provenance = (data["provenance"] ?? {}) as { timestamp?: string }
      return updatePanel(state, String(data["panel"]), String(data["key"]), (current) => ({
        ...current,
        status: "live",
        source: "ws",
        data: data["data"],
        updatedAt: typeof provenance.timestamp === "string" ? provenance.timestamp : new Date().toISOString(),
        reason: undefined,
      }))
    }
    case "session.panel.status": {
      const status = String(data["status"])
      if (status !== "live" && status !== "degraded" && status !== "closed") return state
      return updatePanel(state, String(data["panel"]), String(data["key"]), (current) => ({
        ...current,
        status,
        reason: typeof data["reason"] === "string" ? data["reason"] : undefined,
      }))
    }
    default:
      return state
  }
}

/** True when the envelope belongs to the workspace reducer, not the transcript. */
export function isWorkspaceEvent(type: string): boolean {
  return type === "session.intent.updated" || type === "session.panel.updated" || type === "session.panel.status"
}

/** Apply an HTTP fallback refresh for a degraded panel. */
export function applyPanelSnapshot(
  state: WorkspaceState,
  panel: PanelType,
  key: string,
  data: unknown,
  refreshedAt: string,
): WorkspaceState {
  return updatePanel(state, panel, key, (current) => ({
    ...current,
    data,
    source: "http",
    updatedAt: refreshedAt,
  }))
}
