import { describe, expect, test } from "bun:test"

// Smoke test: the /workflows TUI feature plugin module loads (JSX + dialog)
// and exposes the internal-plugin shape that plugin/internal.ts wires.
describe("workflow.tui-plugin", () => {
  test("module loads and exports an internal TUI plugin", async () => {
    const mod = await import("@tui/feature-plugins/workflows")
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe("internal:workflows")
    expect(typeof mod.default.tui).toBe("function")
  })

  test("internal plugin list includes the workflows plugin", async () => {
    const { internalTuiPlugins } = await import("@tui/plugin/internal")
    const plugins = internalTuiPlugins({ experimentalEventSystem: false })
    expect(plugins.some((plugin) => plugin.id === "internal:workflows")).toBe(true)
  })
})
