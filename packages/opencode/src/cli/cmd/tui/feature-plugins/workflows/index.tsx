// Ultrathink workflows TUI feature:
// - /workflows opens the run progress dialog (the centerpiece view)
// - /effort opens reasoning-effort selection including the ultrathink option
// - a compact one-line progress indicator for active runs in the sidebar
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { Workflow } from "@/workflow"
import type { RunSnapshot } from "@/workflow/run"
import { WorkflowsDialog, formatTokens, statusIcon } from "./dialog"

const id = "internal:workflows"

function workflowsEnabled(api: TuiPluginApi): boolean {
  if (Workflow.disabledByEnv()) return false
  const config = (api.state.config ?? {}) as { disableWorkflows?: boolean }
  return config.disableWorkflows !== true
}

export function EffortDialog() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    const variants = local.model.variant.list()
    return [
      {
        value: "default",
        title: "Default",
        description: "model default reasoning effort",
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(undefined)
        },
      },
      ...variants.map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant)
        },
      })),
      ...(variants.length > 0
        ? [
            {
              value: Workflow.ULTRATHINK_VARIANT,
              title: "ultrathink",
              description: "highest reasoning effort + automatic workflow orchestration",
              onSelect: () => {
                dialog.clear()
                local.model.variant.set(Workflow.ULTRATHINK_VARIANT)
              },
            },
          ]
        : []),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title="Select effort"
      current={local.model.variant.selected()}
      flat={true}
    />
  )
}

function SidebarProgress() {
  const sdk = useSDK()
  const [runs, setRuns] = createSignal<RunSnapshot[]>([])

  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    try {
      const url = new URL("/experimental/workflow", sdk.url)
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      const response = await sdk.fetch(url.toString())
      if (!response.ok) return
      const data = (await response.json()) as RunSnapshot[]
      setRuns(Array.isArray(data) ? data : [])
    } catch {
      // ignore; sidebar is best-effort
    }
  }

  onMount(() => {
    const unsub = sdk.event.on("event", (event) => {
      const type = String((event.payload as { type?: unknown })?.type ?? "")
      if (!type.startsWith("workflow.")) return
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void refresh()
      }, 250)
    })
    onCleanup(() => {
      if (timer) clearTimeout(timer)
      unsub()
    })
  })

  const active = createMemo(() => runs().filter((run) => run.status === "running" || run.status === "paused"))

  return (
    <Show when={active().length > 0}>
      <box>
        <text>
          <b>Workflows</b>
        </text>
        <For each={active()}>
          {(run) => {
            const done = run.phases.filter((phase) => phase.status === "completed").length
            return (
              <text>
                {statusIcon(run.status)} {run.name} · {done}/{run.phases.length} phases · {run.agents.length} agents ·{" "}
                {formatTokens(run.tokens)}
              </text>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    priority: 1000,
    commands: [
      {
        name: "workflows.list",
        title: "Workflows",
        category: "Session",
        namespace: "palette",
        slashName: "workflows",
        suggested: () => workflowsEnabled(api),
        run() {
          if (!workflowsEnabled(api)) {
            api.ui.toast({ message: "Dynamic workflows are disabled", variant: "info" })
            return
          }
          api.ui.dialog.replace(() => <WorkflowsDialog />)
        },
      },
      {
        name: "effort.select",
        title: "Select reasoning effort",
        category: "Model",
        namespace: "palette",
        slashName: "effort",
        run() {
          api.ui.dialog.replace(() => <EffortDialog />)
        },
      },
    ],
  })

  api.slots.register({
    order: 450,
    slots: {
      sidebar_content() {
        if (!workflowsEnabled(api)) return null
        return <SidebarProgress />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
