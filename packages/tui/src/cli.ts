/**
 * Flag parsing for the `gta` bin entry. Kept pure so it can be unit tested.
 */
import path from "node:path"

export const VERSION = "1.16.0"

export type CliOptions = {
  readonly help: boolean
  readonly version: boolean
  /** Start a real TCP listener (default is in-process only, no TCP). */
  readonly listen: boolean
  readonly hostname: string
  readonly port?: number
  /** Runtime scope directory for new sessions. */
  readonly directory: string
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string }

export function parseArgs(argv: readonly string[], cwd: string): ParseResult {
  let help = false
  let version = false
  let listen = false
  let hostname = "127.0.0.1"
  let port: number | undefined
  let directory = cwd

  const take = (index: number): string | undefined => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--")) return undefined
    return value
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--help":
      case "-h":
        help = true
        break
      case "--version":
      case "-v":
        version = true
        break
      case "--listen":
        listen = true
        break
      case "--port": {
        const value = take(index)
        if (value === undefined) return { ok: false, error: "--port requires a value" }
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          return { ok: false, error: `Invalid port: ${value}` }
        }
        port = parsed
        listen = true
        index++
        break
      }
      case "--hostname": {
        const value = take(index)
        if (value === undefined) return { ok: false, error: "--hostname requires a value" }
        hostname = value
        listen = true
        index++
        break
      }
      case "--directory": {
        const value = take(index)
        if (value === undefined) return { ok: false, error: "--directory requires a value" }
        directory = path.isAbsolute(value) ? value : path.resolve(cwd, value)
        index++
        break
      }
      default:
        return { ok: false, error: `Unknown option: ${arg}` }
    }
  }

  return { ok: true, options: { help, version, listen, hostname, port, directory } }
}

export function helpText(): string {
  return [
    "gta — GTE Agent TUI",
    "",
    "Usage: gta [options]",
    "",
    "Runs the canonical GTE Agent runtime in-process (worker, no TCP socket)",
    "and opens the terminal UI against it.",
    "",
    "Options:",
    "  --listen              also start a real HTTP listener (default off)",
    "  --port <port>         listener port (implies --listen, default 4096)",
    "  --hostname <host>     listener hostname (implies --listen, default 127.0.0.1)",
    "  --directory <path>    runtime scope directory for new sessions (default cwd)",
    "  -h, --help            show this help",
    "  -v, --version         show version",
    "",
    "Headless server: use `gte-agent serve` from @gte-agent/cli instead.",
  ].join("\n")
}
