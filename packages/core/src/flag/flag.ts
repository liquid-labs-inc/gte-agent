import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["GTE_AGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("GTE_AGENT_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  GTE_AGENT_AUTO_HEAP_SNAPSHOT: truthy("GTE_AGENT_AUTO_HEAP_SNAPSHOT"),
  GTE_AGENT_GIT_BASH_PATH: process.env["GTE_AGENT_GIT_BASH_PATH"],
  GTE_AGENT_CONFIG: process.env["GTE_AGENT_CONFIG"],
  GTE_AGENT_CONFIG_CONTENT: process.env["GTE_AGENT_CONFIG_CONTENT"],
  GTE_AGENT_DISABLE_AUTOUPDATE: truthy("GTE_AGENT_DISABLE_AUTOUPDATE"),
  GTE_AGENT_ALWAYS_NOTIFY_UPDATE: truthy("GTE_AGENT_ALWAYS_NOTIFY_UPDATE"),
  GTE_AGENT_DISABLE_PRUNE: truthy("GTE_AGENT_DISABLE_PRUNE"),
  GTE_AGENT_DISABLE_TERMINAL_TITLE: truthy("GTE_AGENT_DISABLE_TERMINAL_TITLE"),
  GTE_AGENT_SHOW_TTFD: truthy("GTE_AGENT_SHOW_TTFD"),
  GTE_AGENT_DISABLE_AUTOCOMPACT: truthy("GTE_AGENT_DISABLE_AUTOCOMPACT"),
  GTE_AGENT_DISABLE_MODELS_FETCH: truthy("GTE_AGENT_DISABLE_MODELS_FETCH"),
  GTE_AGENT_DISABLE_MOUSE: truthy("GTE_AGENT_DISABLE_MOUSE"),
  GTE_AGENT_FAKE_VCS: process.env["GTE_AGENT_FAKE_VCS"],
  GTE_AGENT_SERVER_PASSWORD: process.env["GTE_AGENT_SERVER_PASSWORD"],
  GTE_AGENT_SERVER_USERNAME: process.env["GTE_AGENT_SERVER_USERNAME"],

  // Experimental
  GTE_AGENT_EXPERIMENTAL_FILEWATCHER: Config.boolean("GTE_AGENT_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  GTE_AGENT_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("GTE_AGENT_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  GTE_AGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("GTE_AGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  GTE_AGENT_MODELS_URL: process.env["GTE_AGENT_MODELS_URL"],
  GTE_AGENT_MODELS_PATH: process.env["GTE_AGENT_MODELS_PATH"],
  GTE_AGENT_DB: process.env["GTE_AGENT_DB"],

  GTE_AGENT_WORKSPACE_ID: process.env["GTE_AGENT_WORKSPACE_ID"],
  GTE_AGENT_EXPERIMENTAL_WORKSPACES: enabledByExperimental("GTE_AGENT_EXPERIMENTAL_WORKSPACES"),
  GTE_AGENT_EXPERIMENTAL_SESSION_SWITCHER: enabledByExperimental("GTE_AGENT_EXPERIMENTAL_SESSION_SWITCHER"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get GTE_AGENT_DISABLE_PROJECT_CONFIG() {
    return truthy("GTE_AGENT_DISABLE_PROJECT_CONFIG")
  },
  get GTE_AGENT_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("GTE_AGENT_EXPERIMENTAL_REFERENCES")
  },
  get GTE_AGENT_TUI_CONFIG() {
    return process.env["GTE_AGENT_TUI_CONFIG"]
  },
  get GTE_AGENT_CONFIG_DIR() {
    return process.env["GTE_AGENT_CONFIG_DIR"]
  },
  get GTE_AGENT_PURE() {
    return truthy("GTE_AGENT_PURE")
  },
  get GTE_AGENT_DISABLE_WORKFLOWS() {
    return truthy("GTE_AGENT_DISABLE_WORKFLOWS")
  },
  get GTE_AGENT_DISABLE_DYNAMIC_TOOLS() {
    return truthy("GTE_AGENT_DISABLE_DYNAMIC_TOOLS")
  },
  get GTE_AGENT_PERMISSION() {
    return process.env["GTE_AGENT_PERMISSION"]
  },
  get GTE_AGENT_PLUGIN_META_FILE() {
    return process.env["GTE_AGENT_PLUGIN_META_FILE"]
  },
  get GTE_AGENT_CLIENT() {
    return process.env["GTE_AGENT_CLIENT"] ?? "cli"
  },
}
