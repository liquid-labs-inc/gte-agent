import { For, Show } from "solid-js"
import type { WorkspaceState, PanelView } from "../state/workspace"
import { panelID } from "../state/workspace"
import { summarizeData } from "../state/summarize"
import { theme } from "./theme"

/**
 * Live data workspace (Milestone 5).
 *
 * Renders the session's pinned panels: a compact stacked list with a detail
 * view for the focused panel. Every panel header shows type + key + data
 * source (live WS, snapshot fallback with refreshed-at) plus the GTE env.
 * Read-only by design: no order affordances, no trading recommendations.
 */

function clock(iso?: string): string {
  if (iso === undefined) return ""
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(11, 19)
}

function sourceLabel(panel: PanelView): string {
  switch (panel.status) {
    case "live":
      return panel.source === "http" ? `snapshot ${clock(panel.updatedAt)}` : `live ws ${clock(panel.updatedAt)}`
    case "degraded":
      return panel.data !== undefined && panel.source === "http"
        ? `snapshot (fallback) ${clock(panel.updatedAt)}`
        : "degraded — snapshot fallback"
    case "closed":
      return "closed"
    case "pending":
    default:
      return "connecting…"
  }
}

function statusColor(panel: PanelView): string {
  switch (panel.status) {
    case "live":
      return theme.ok
    case "degraded":
      return theme.error
    default:
      return theme.muted
  }
}

function PanelDetail(props: { panel: PanelView }) {
  const summary = () => summarizeData(props.panel.data)
  return (
    <box flexDirection="column" border={["top"]} borderColor={theme.border}>
      <text fg={theme.accent} wrapMode="word">
        {props.panel.panel} {props.panel.key}
      </text>
      <text fg={statusColor(props.panel)}>{sourceLabel(props.panel)}</text>
      <Show when={props.panel.reason}>
        <text fg={theme.muted} wrapMode="word">
          {props.panel.reason}
        </text>
      </Show>
      <Show
        when={props.panel.data !== undefined}
        fallback={<text fg={theme.muted}>no data yet</text>}
      >
        <Show when={summary().fields}>
          <For each={Object.entries(summary().fields ?? {})}>
            {([key, value]) => (
              <text fg={theme.text} wrapMode="word">
                {key}: {value}
              </text>
            )}
          </For>
        </Show>
        <For each={(summary().rows ?? []).slice(0, 8)}>
          {(row) => (
            <text fg={theme.muted} wrapMode="word">
              {Object.entries(row)
                .map(([key, value]) => `${key}=${value === null ? "—" : String(value)}`)
                .join(" ")}
            </text>
          )}
        </For>
        <Show when={summary().note}>
          <text fg={theme.muted} wrapMode="word">
            {summary().note}
          </text>
        </Show>
      </Show>
    </box>
  )
}

export function DataWorkspace(props: { workspace: WorkspaceState; env?: string }) {
  const focused = () =>
    props.workspace.panels.find((panel) => panelID(panel.panel, panel.key) === props.workspace.focused) ??
    props.workspace.panels[0]

  return (
    <box
      width={44}
      flexShrink={0}
      flexDirection="column"
      border
      borderColor={theme.border}
      title="data workspace"
      padding={1}
    >
      <text fg={theme.muted}>env: {props.env ?? "—"}</text>
      <text fg={theme.muted} wrapMode="word">
        market: {props.workspace.selectedMarket ?? "—"}
      </text>
      <text fg={theme.muted} wrapMode="word">
        tracked address: {props.workspace.trackedAddress ?? "—"}
      </text>
      <text> </text>
      <Show
        when={props.workspace.panels.length > 0}
        fallback={
          <text fg={theme.muted} wrapMode="word">
            No data panels pinned — open one with /book &lt;symbol&gt;, /trades &lt;symbol&gt;, /positions
            &lt;address&gt;, …
          </text>
        }
      >
        <For each={props.workspace.panels}>
          {(panel) => (
            <text
              fg={panelID(panel.panel, panel.key) === props.workspace.focused ? theme.accent : theme.text}
              wrapMode="word"
            >
              {panelID(panel.panel, panel.key) === props.workspace.focused ? "▸ " : "  "}
              {panel.panel} {panel.key} · {sourceLabel(panel)}
            </text>
          )}
        </For>
        <Show when={focused()}>{(panel) => <PanelDetail panel={panel()} />}</Show>
      </Show>
    </box>
  )
}
