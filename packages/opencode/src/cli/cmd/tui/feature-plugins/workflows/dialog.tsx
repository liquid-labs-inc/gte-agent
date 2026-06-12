// /workflows — live progress view for ultrathink workflow runs.
//
// Levels: run list → run (phases) → phase (agents) → agent detail.
// Keybinds: ↑/↓ select · tab/→ focus agents from run view · enter drill in · esc/← back · j/k scroll detail ·
// p pause/resume · x stop agent/run · r restart agent · s save as command.
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { useBindings } from "@tui/keymap"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import type { AgentState, RunSnapshot } from "@/workflow/run"

type Level = "list" | "run" | "phase" | "agent"
type RunFocus = "phases" | "agents"

export function formatTokens(tokens: { input: number; output: number }): string {
  const total = tokens.input + tokens.output
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k tok`
  return `${total} tok`
}

export function formatElapsed(startedAt: number, finishedAt: number | undefined, now: number): string {
  const ms = Math.max(0, (finishedAt ?? now) - startedAt)
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`
  return `${seconds}s`
}

export function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "●"
    case "queued":
      return "◌"
    case "paused":
      return "⏸"
    case "completed":
      return "✓"
    case "error":
      return "✗"
    default:
      return "·"
  }
}

function firstLine(text: string, max = 80): string {
  const line = text.split("\n").find((item) => item.trim()) ?? ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  return text.length > max ? text.slice(0, Math.max(0, max - 1)) + "…" : text
}

function borderLine(kind: "top" | "bottom", width: number, title?: string): string {
  const left = kind === "top" ? "┌" : "└"
  const right = kind === "top" ? "┐" : "┘"
  if (kind === "bottom" || !title) return left + "─".repeat(Math.max(0, width - 2)) + right
  const label = ` ${truncate(title, Math.max(1, width - 6))} `
  return left + "─" + label + "─".repeat(Math.max(0, width - label.length - 3)) + right
}

export function WorkflowsDialog() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()
  const dimensions = useTerminalDimensions()

  const [runs, setRuns] = createSignal<RunSnapshot[]>([])
  const [level, setLevel] = createSignal<Level>("list")
  const [runID, setRunID] = createSignal<string | undefined>(undefined)
  const [runIdx, setRunIdx] = createSignal(0)
  const [phaseIdx, setPhaseIdx] = createSignal(0)
  const [agentIdx, setAgentIdx] = createSignal(0)
  const [agentID, setAgentID] = createSignal<string | undefined>(undefined)
  const [runFocus, setRunFocus] = createSignal<RunFocus>("phases")
  const [scroll, setScroll] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  function statusColor(status: string) {
    switch (status) {
      case "running":
        return theme.primary
      case "paused":
        return theme.warning
      case "completed":
        return theme.success
      case "error":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  async function api(path: string, init?: RequestInit) {
    const url = new URL(path, sdk.url)
    if (sdk.directory) url.searchParams.set("directory", sdk.directory)
    return sdk.fetch(url.toString(), init)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    try {
      const response = await api("/experimental/workflow")
      if (!response.ok) return
      const data = (await response.json()) as RunSnapshot[]
      setRuns(Array.isArray(data) ? data : [])
    } catch {
      // server unreachable; keep last state
    }
  }
  function scheduleRefresh() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 150)
  }

  onMount(() => {
    void refresh()
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const unsub = sdk.event.on("event", (event) => {
      const type = String((event.payload as { type?: unknown })?.type ?? "")
      if (type.startsWith("workflow.")) scheduleRefresh()
    })
    onCleanup(() => {
      clearInterval(tick)
      if (timer) clearTimeout(timer)
      unsub()
    })
  })

  const sorted = createMemo(() => runs())
  const run = createMemo(() => {
    const id = runID()
    return sorted().find((item) => item.id === id) ?? sorted()[runIdx()]
  })
  const phases = createMemo(() => run()?.phases ?? [])
  const phase = createMemo(() => phases()[phaseIdx()])
  const agents = createMemo<AgentState[]>(() => {
    const current = run()
    const name = phase()?.name
    if (!current || !name) return []
    return current.agents.filter((agent) => agent.phase === name)
  })
  const agent = createMemo(() => {
    const id = agentID()
    return agents().find((item) => item.id === id) ?? agents()[agentIdx()]
  })
  const runWidth = createMemo(() => Math.min(116, Math.max(1, dimensions().width - 2)))
  const runContentWidth = createMemo(() => Math.max(40, runWidth() - 4))
  const wideRunView = createMemo(() => dimensions().width >= 100)
  const phasePanelWidth = createMemo(() => Math.max(24, Math.min(32, Math.floor(runContentWidth() * 0.26))))
  const agentPanelWidth = createMemo(() => Math.max(40, runContentWidth() - phasePanelWidth() - 1))
  const completedAgentCount = createMemo(() => run()?.agents.filter((item) => item.status === "completed").length ?? 0)

  function clamp(value: number, length: number) {
    return Math.max(0, Math.min(value, Math.max(0, length - 1)))
  }

  function move(delta: number) {
    switch (level()) {
      case "list":
        setRunIdx((index) => clamp(index + delta, sorted().length))
        setRunID(undefined)
        return
      case "run":
        if (runFocus() === "agents") {
          setAgentIdx((index) => clamp(index + delta, agents().length))
          setAgentID(undefined)
          return
        }
        setPhaseIdx((index) => {
          const next = clamp(index + delta, phases().length)
          if (next !== index) {
            setAgentIdx(0)
            setAgentID(undefined)
          }
          return next
        })
        return
      case "phase":
        setAgentIdx((index) => clamp(index + delta, agents().length))
        setAgentID(undefined)
        return
      case "agent":
        setScroll((value) => Math.max(0, value + delta))
        return
    }
  }

  function drill() {
    switch (level()) {
      case "list": {
        const selected = sorted()[runIdx()]
        if (!selected) return
        setRunID(selected.id)
        setPhaseIdx(0)
        setAgentIdx(0)
        setAgentID(undefined)
        setRunFocus("phases")
        setLevel("run")
        return
      }
      case "run": {
        if (!phase()) return
        if (runFocus() === "agents") {
          const selected = agents()[agentIdx()]
          if (!selected) return
          setAgentID(selected.id)
          setScroll(0)
          setLevel("agent")
          return
        }
        setAgentIdx(0)
        setAgentID(undefined)
        setLevel("phase")
        return
      }
      case "phase": {
        const selected = agents()[agentIdx()]
        if (!selected) return
        setAgentID(selected.id)
        setScroll(0)
        setLevel("agent")
        return
      }
    }
  }

  function back() {
    switch (level()) {
      case "agent":
        setLevel("phase")
        return
      case "phase":
        setLevel("run")
        setRunFocus("agents")
        return
      case "run":
        setLevel("list")
        return
      case "list":
        dialog.clear()
        return
    }
  }

  function focusForward() {
    if (level() === "run") {
      setRunFocus("agents")
      setAgentIdx((index) => clamp(index, agents().length))
      setAgentID(undefined)
      return
    }
    drill()
  }

  function focusBack() {
    if (level() === "run" && runFocus() === "agents") {
      setRunFocus("phases")
      return
    }
    back()
  }

  async function control(body: Record<string, unknown>, okMessage: string) {
    const current = run()
    if (!current) return
    try {
      const response = await api(`/experimental/workflow/${current.id}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = (await response.json().catch(() => undefined)) as { ok?: boolean; path?: string } | undefined
      if (response.ok && payload?.ok) {
        toast.show({ message: payload.path ? `${okMessage}: ${payload.path}` : okMessage, variant: "info" })
      } else {
        toast.show({ message: "Workflow action failed", variant: "warning" })
      }
    } catch {
      toast.show({ message: "Workflow action failed", variant: "error" })
    }
    void refresh()
  }

  function pauseResume() {
    const current = run()
    if (!current) return
    if (current.status === "paused") {
      void control({ action: "resume" }, "Workflow resumed")
    } else if (current.status === "running") {
      void control({ action: "pause" }, "Workflow paused")
    }
  }

  function stop() {
    if (level() === "phase" || level() === "agent" || (level() === "run" && runFocus() === "agents")) {
      const selected = agent()
      if (selected && (selected.status === "running" || selected.status === "queued")) {
        void control({ action: "stop-agent", agentID: selected.id }, "Agent stopped")
        return
      }
    }
    const current = run()
    if (!current) return
    if (current.status === "running" || current.status === "paused") {
      void control({ action: "cancel" }, "Workflow stopped")
    }
  }

  function restart() {
    if (level() !== "phase" && level() !== "agent" && !(level() === "run" && runFocus() === "agents")) return
    const selected = agent()
    if (!selected || selected.status !== "running") return
    void control({ action: "restart-agent", agentID: selected.id }, "Agent restarted")
  }

  function save() {
    const current = run()
    if (!current) return
    const id = current.id
    const reopen = () => dialog.replace(() => <WorkflowsDialog />)
    dialog.replace(() => (
      <DialogPrompt
        title="Save workflow as command"
        placeholder={current.name}
        description={() => (
          <text fg={theme.textMuted}>Saves to .opencode/workflows/&lt;name&gt;.mjs — runs as /&lt;name&gt;</text>
        )}
        onCancel={reopen}
        onConfirm={async (value) => {
          const name = (value.trim() || current.name).replace(/\s+/g, "-").toLowerCase()
          try {
            const url = new URL(`/experimental/workflow/${id}/control`, sdk.url)
            if (sdk.directory) url.searchParams.set("directory", sdk.directory)
            const response = await sdk.fetch(url.toString(), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "save", name }),
            })
            const payload = (await response.json().catch(() => undefined)) as { path?: string } | undefined
            toast.show({
              message: response.ok ? `Saved: ${payload?.path ?? name} (run with /${name})` : "Save failed",
              variant: response.ok ? "info" : "warning",
            })
          } catch {
            toast.show({ message: "Save failed", variant: "error" })
          }
          reopen()
        }}
      />
    ))
  }

  useBindings(() => ({
    priority: 1,
    commands: [
      { name: "workflows.up", title: "Select previous", category: "Workflows", run: () => move(-1) },
      { name: "workflows.down", title: "Select next", category: "Workflows", run: () => move(1) },
      { name: "workflows.drill", title: "Drill in", category: "Workflows", run: drill },
      { name: "workflows.focusForward", title: "Focus next pane", category: "Workflows", run: focusForward },
      { name: "workflows.focusBack", title: "Focus previous pane", category: "Workflows", run: focusBack },
      { name: "workflows.back", title: "Back", category: "Workflows", run: back },
      { name: "workflows.pause", title: "Pause/resume run", category: "Workflows", run: pauseResume },
      { name: "workflows.stop", title: "Stop agent or run", category: "Workflows", run: stop },
      { name: "workflows.restart", title: "Restart agent", category: "Workflows", run: restart },
      { name: "workflows.save", title: "Save run as command", category: "Workflows", run: save },
    ],
    bindings: [
      { key: "up", cmd: "workflows.up", desc: "Select previous" },
      { key: "down", cmd: "workflows.down", desc: "Select next" },
      { key: "k", cmd: "workflows.up", desc: "Select previous / scroll up" },
      { key: "j", cmd: "workflows.down", desc: "Select next / scroll down" },
      { key: "return", cmd: "workflows.drill", desc: "Drill in" },
      { key: "right,tab", cmd: "workflows.focusForward", desc: "Focus agents / drill in" },
      { key: "left", cmd: "workflows.focusBack", desc: "Focus phases / back" },
      { key: "escape", cmd: "workflows.back", desc: "Back" },
      { key: "p", cmd: "workflows.pause", desc: "Pause/resume" },
      { key: "x", cmd: "workflows.stop", desc: "Stop agent/run" },
      { key: "r", cmd: "workflows.restart", desc: "Restart agent" },
      { key: "s", cmd: "workflows.save", desc: "Save as command" },
    ],
  }))

  onMount(() => dialog.setSize("xlarge"))

  const hints = createMemo(() => {
    switch (level()) {
      case "list":
        return "↑/↓ select · enter drill in · p pause/resume · x stop · s save · esc close"
      case "run":
        return runFocus() === "agents"
          ? "↑/↓ agent · enter detail · ← phases · x stop agent · r restart · esc back"
          : "↑/↓ phase · tab/→ agents · enter phase list · p pause/resume · x stop run · s save · esc back"
      case "phase":
        return "↑/↓ agent · enter detail · x stop agent · r restart · esc back"
      case "agent":
        return "j/k scroll · x stop · r restart · esc back"
    }
  })

  const detailLines = createMemo(() => {
    const selected = agent()
    if (!selected) return []
    const lines: string[] = []
    lines.push(`agent ${selected.id} · @${selected.type ?? "general"} · ${selected.status}`)
    if (selected.model) lines.push(`model: ${selected.model}${selected.variant ? ` · ${selected.variant}` : ""}`)
    else if (selected.variant) lines.push(`variant: ${selected.variant}`)
    if (selected.sessionID) lines.push(`session: ${selected.sessionID}`)
    lines.push(`tokens: ${formatTokens(selected.tokens)} · attempt ${selected.attempt}`)
    lines.push("")
    lines.push("── prompt ──")
    lines.push(...selected.prompt.split("\n"))
    if (selected.result) {
      lines.push("")
      lines.push("── result ──")
      lines.push(...selected.result.split("\n"))
    }
    if (selected.error) {
      lines.push("")
      lines.push("── error ──")
      lines.push(...selected.error.split("\n"))
    }
    return lines
  })

  const VISIBLE_DETAIL = 18

  function phaseAgents(name: string) {
    return run()?.agents.filter((item) => item.phase === name) ?? []
  }

  function phaseCompleted(name: string) {
    return phaseAgents(name).filter((item) => item.status === "completed").length
  }

  function phaseCount(name: string, total: number) {
    return `${phaseCompleted(name)}/${total}`
  }

  function agentModel(item: AgentState) {
    const model = item.model?.split("/").at(-1) ?? item.type ?? "general"
    return item.variant ? `${model} · ${item.variant}` : model
  }

  function agentStats(item: AgentState) {
    const parts = [formatTokens(item.tokens)]
    if (item.finishedAt) parts.push(formatElapsed(item.startedAt, item.finishedAt, now()))
    return parts.join(" · ")
  }

  function agentGlyphColor(status: string) {
    if (status === "completed") return theme.success
    if (status === "error" || status === "cancelled") return theme.error
    return theme.textMuted
  }

  function TitledPanel(props: { title: string; width: number; children: JSX.Element }) {
    return (
      <box width={props.width} flexShrink={0} minWidth={0}>
        <text fg={theme.border}>{borderLine("top", props.width, props.title)}</text>
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <text fg={theme.border}>│</text>
          <box width={Math.max(1, props.width - 2)} minWidth={0} flexGrow={1}>
            {props.children}
          </box>
          <text fg={theme.border}>│</text>
        </box>
        <text fg={theme.border}>{borderLine("bottom", props.width)}</text>
      </box>
    )
  }

  return (
    <box gap={1} paddingBottom={1} flexGrow={1}>
      <box paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={level() === "run" ? theme.primary : theme.text} attributes={TextAttributes.BOLD}>
            {level() === "list" && "Workflows"}
            {level() === "run" && (run()?.name ?? "")}
            {level() === "phase" && `${run()?.name ?? ""} › ${phase()?.name ?? ""}`}
            {level() === "agent" && `${run()?.name ?? ""} › ${phase()?.name ?? ""} › ${agent()?.id ?? ""}`}
          </text>
          <text fg={theme.textMuted}>esc</text>
        </box>
      </box>

      <box paddingLeft={2} paddingRight={2} flexGrow={1} minHeight={0}>
        <Show when={level() === "list"}>
          <Show
            when={sorted().length > 0}
            fallback={<text fg={theme.textMuted}>No workflow runs in this session yet. Launch one with /workflow or the ultrathink keyword.</text>}
          >
            <For each={sorted()}>
              {(item, index) => (
                <box flexDirection="row" gap={1} backgroundColor={index() === runIdx() ? theme.backgroundElement : undefined}>
                  <text fg={statusColor(item.status)}>{statusIcon(item.status)}</text>
                  <text fg={theme.text} flexGrow={1}>
                    {item.name}
                  </text>
                  <text fg={theme.textMuted}>
                    {item.phases.length} phases · {item.agents.length} agents · {formatTokens(item.tokens)} ·{" "}
                    {formatElapsed(item.startedAt, item.finishedAt, now())}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>

        <Show when={level() === "run"}>
          <box gap={1} minHeight={0}>
            <box flexDirection="row" gap={1}>
              <text fg={statusColor(run()?.status ?? "")}>{statusIcon(run()?.status ?? "")}</text>
              <text fg={theme.textMuted} flexGrow={1} wrapMode="none">
                {run()?.status} · {formatTokens(run()?.tokens ?? { input: 0, output: 0 })} ·{" "}
                {truncate(run()?.scriptPath ?? "script pending", Math.max(10, runContentWidth() - 34))}
              </text>
              <text fg={theme.textMuted}>
                {completedAgentCount()}/{run()?.agentTotal ?? run()?.agents.length ?? 0} agents ·{" "}
                {formatElapsed(run()?.startedAt ?? now(), run()?.finishedAt, now())}
              </text>
            </box>

            <Show
              when={wideRunView()}
              fallback={
                <box gap={1}>
                  <Show when={phases().length > 0} fallback={<text fg={theme.textMuted}>No phases yet…</text>}>
                    <For each={phases()}>
                      {(item, index) => (
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={index() === phaseIdx() ? theme.backgroundElement : undefined}
                        >
                          <text fg={item.status === "running" ? theme.primary : theme.success}>
                            {item.status === "running" ? "●" : "✓"}
                          </text>
                          <text fg={theme.text} flexGrow={1}>
                            {item.name}
                          </text>
                          <text fg={theme.textMuted}>
                            {item.agentCount} agents · {formatTokens(item.tokens)} ·{" "}
                            {formatElapsed(item.startedAt, item.finishedAt, now())}
                          </text>
                        </box>
                      )}
                    </For>
                  </Show>
                  <Show when={(run()?.logs.length ?? 0) > 0}>
                    <box paddingTop={1}>
                      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                        log
                      </text>
                      <For each={(run()?.logs ?? []).slice(-5)}>
                        {(line) => <text fg={theme.textMuted}>{firstLine(line.message, 100)}</text>}
                      </For>
                    </box>
                  </Show>
                </box>
              }
            >
              <box flexDirection="row" gap={1} minHeight={0}>
                <TitledPanel title="Phases" width={phasePanelWidth()}>
                  <Show when={phases().length > 0} fallback={<text fg={theme.textMuted}> No phases yet…</text>}>
                    <For each={phases()}>
                      {(item, index) => {
                        const selected = () => index() === phaseIdx()
                        const focused = () => selected() && runFocus() === "phases"
                        const count = () => phaseCount(item.name, item.agentCount)
                        const muted = () => !selected() && item.status !== "completed"
                        const labelWidth = () => Math.max(8, phasePanelWidth() - 15)
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={focused() ? theme.backgroundElement : undefined}
                          >
                            <text
                              fg={selected() ? theme.primary : item.status === "completed" ? theme.success : theme.textMuted}
                              width={4}
                              wrapMode="none"
                            >
                              {selected() ? `❯ ${index() + 1}` : item.status === "completed" ? "✓" : `${index() + 1}`}
                            </text>
                            <text
                              fg={selected() ? theme.primary : muted() ? theme.textMuted : theme.text}
                              width={labelWidth()}
                              wrapMode="none"
                            >
                              {truncate(item.name, labelWidth())}
                            </text>
                            <box flexGrow={1} />
                            <Show when={selected() || item.status === "completed" || item.status === "running"}>
                              <text fg={selected() ? theme.primary : theme.textMuted}>{count()}</text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                </TitledPanel>

                <TitledPanel title={`${phase()?.name ?? "Phase"} · ${agents().length} agents`} width={agentPanelWidth()}>
                  <Show when={agents().length > 0} fallback={<text fg={theme.textMuted}> No agents in this phase yet…</text>}>
                    <For each={agents()}>
                      {(item, index) => {
                        const selected = () => runFocus() === "agents" && index() === agentIdx()
                        const muted = () => item.status === "running" || item.status === "queued"
                        const labelWidth = () => Math.max(16, agentPanelWidth() - 42)
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={selected() ? theme.backgroundElement : undefined}
                          >
                            <text fg={agentGlyphColor(item.status)}>{statusIcon(item.status)}</text>
                            <text
                              fg={selected() ? theme.text : muted() ? theme.textMuted : theme.text}
                              width={labelWidth()}
                              wrapMode="none"
                            >
                              {truncate(`${item.id} ${firstLine(item.prompt, 120)}`, labelWidth())}
                            </text>
                            <text fg={theme.textMuted} width={15} wrapMode="none">
                              {truncate(agentModel(item), 15)}
                            </text>
                            <box flexGrow={1} />
                            <text fg={theme.textMuted}>{agentStats(item)}</text>
                          </box>
                        )
                      }}
                    </For>
                  </Show>
                </TitledPanel>
              </box>
            </Show>

            <Show when={run()?.error}>
              <text fg={theme.error}>{firstLine(run()?.error ?? "", 120)}</text>
            </Show>
          </box>
        </Show>

        <Show when={level() === "phase"}>
          <Show when={agents().length > 0} fallback={<text fg={theme.textMuted}>No agents in this phase yet…</text>}>
            <For each={agents()}>
              {(item, index) => (
                <box flexDirection="row" gap={1} backgroundColor={index() === agentIdx() ? theme.backgroundElement : undefined}>
                  <text fg={statusColor(item.status)}>{statusIcon(item.status)}</text>
                  <text fg={theme.textMuted}>{item.id}</text>
                  <text fg={theme.text} flexGrow={1}>
                    {firstLine(item.prompt, 60)}
                  </text>
                  <text fg={theme.textMuted}>
                    {formatTokens(item.tokens)} · {formatElapsed(item.startedAt, item.finishedAt, now())}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>

        <Show when={level() === "agent"}>
          <For each={detailLines().slice(scroll(), scroll() + VISIBLE_DETAIL)}>
            {(line) => <text fg={theme.text}>{line || " "}</text>}
          </For>
          <Show when={detailLines().length > VISIBLE_DETAIL}>
            <text fg={theme.textMuted}>
              ({Math.min(scroll() + VISIBLE_DETAIL, detailLines().length)}/{detailLines().length} lines)
            </text>
          </Show>
        </Show>
      </box>

      <box paddingLeft={2} paddingRight={2}>
        <text fg={theme.textMuted}>{hints()}</text>
      </box>
    </box>
  )
}
