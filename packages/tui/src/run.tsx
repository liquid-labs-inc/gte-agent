/**
 * TUI runtime: starts the worker-hosted canonical server, wires the API
 * client and event subscriber over the in-process channel (or a real
 * listener when network flags are passed), renders the app, and tears
 * everything down on exit.
 */
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { readAuthStatus } from "./api/auth"
import { createApi } from "./api/client"
import { createEventSubscriber } from "./api/events"
import { createGteApi } from "./api/gte"
import { createModelsApi } from "./api/models"
import { createWorkflowsApi } from "./api/workflows"
import type { CliOptions } from "./cli"
import { VERSION } from "./cli"
import { startServerBridge, VIRTUAL_ORIGIN } from "./server/bridge"
import { App } from "./ui/app"
import type { ServerStatus } from "./ui/status-bar"

export async function runTui(options: CliOptions): Promise<void> {
  const bridge = await startServerBridge()

  let server: ServerStatus = { mode: "in-process", url: VIRTUAL_ORIGIN }
  let fetcher: typeof fetch = bridge.fetch
  let baseUrl = VIRTUAL_ORIGIN

  try {
    if (options.listen) {
      const { url } = await bridge.listen({
        hostname: options.hostname,
        port: options.port ?? 4096,
      })
      const trimmed = url.endsWith("/") ? url.slice(0, -1) : url
      server = { mode: "listening", url: trimmed }
      baseUrl = trimmed
      fetcher = globalThis.fetch.bind(globalThis)
    }

    const api = createApi({ baseUrl, fetch: fetcher })
    const healthy = await api.health()
    if (!healthy) throw new Error("GTE Agent server reported unhealthy")

    const gte = createGteApi({ baseUrl, fetch: fetcher })
    const models = createModelsApi({ baseUrl, fetch: fetcher })
    const workflows = createWorkflowsApi({ baseUrl, fetch: fetcher })
    const subscribe = createEventSubscriber({ baseUrl, fetch: fetcher })
    const auth = readAuthStatus()

    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      targetFps: 60,
      gatherStats: false,
      autoFocus: false,
    })

    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    let exited = false
    const exit = () => {
      if (exited) return
      exited = true
      resolveDone()
    }

    renderer.on("destroy", exit)
    process.on("SIGINT", exit)
    process.on("SIGTERM", exit)
    process.on("SIGHUP", exit)

    try {
      await render(
        () => (
          <App
            api={api}
            gte={gte}
            models={models}
            workflows={workflows}
            subscribe={subscribe}
            auth={auth}
            server={server}
            directory={options.directory}
            version={VERSION}
            onExit={exit}
          />
        ),
        renderer,
      )
      await done
    } finally {
      process.off("SIGINT", exit)
      process.off("SIGTERM", exit)
      process.off("SIGHUP", exit)
      if (!renderer.isDestroyed) renderer.destroy()
    }
  } finally {
    await bridge.shutdown()
  }
}
