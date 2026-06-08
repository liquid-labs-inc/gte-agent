import path from "path"
import fs from "fs/promises"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"

const app = "gte-agent"
const base = process.env.GTE_AGENT_HOME ?? path.join(os.tmpdir(), app)
const data = process.env.GTE_AGENT_DATA_DIR ?? path.join(base, "data")
const cache = process.env.GTE_AGENT_CACHE_DIR ?? path.join(base, "cache")
const config = process.env.GTE_AGENT_CONFIG_DIR ?? path.join(base, "config")
const state = process.env.GTE_AGENT_STATE_DIR ?? path.join(base, "state")
const tmp = process.env.GTE_AGENT_TMP_DIR ?? path.join(base, "tmp")

const paths = {
  get home() {
    return process.env.GTE_AGENT_TEST_HOME ?? process.env.GTE_AGENT_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@gte-agent/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.GTE_AGENT_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
