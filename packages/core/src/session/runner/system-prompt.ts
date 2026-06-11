export * as SessionRunnerSystemPrompt from "./system-prompt"

import { Context, Effect, Layer, Option } from "effect"
import { GteData } from "../../gte-data/gte-data"
import type { SessionSchema } from "../schema"

/**
 * Minimal GTE-owned system prompt (Milestone 7): the read-only trading-data
 * assistant persona, the read-only boundary stated explicitly, guidance for
 * the `gte_*` tool catalog, and the per-session context (GTE environment,
 * tracked address, selected market). Full prompt engineering, formatting
 * policy, and evals are later work.
 */
export interface Input {
  readonly gteEnv?: string
  readonly trackedAddress?: string
  readonly selectedMarket?: string
}

export function render(input: Input): string {
  return [
    "You are GTE Agent, a read-only trading-data assistant for the GTE exchange.",
    "",
    "You help users inspect GTE markets, order books, trades, candles, positions, orders, balances, funding, and account activity. You answer with exchange data, not advice.",
    "",
    "Read-only boundary:",
    "- You can only read exchange data. You cannot place, modify, or cancel orders, transfer funds, change leverage, or mutate any account state, and you must never claim to have done so.",
    "- Never produce trading recommendations, order previews, or ready-to-submit order payloads. If asked to trade, explain that this agent is read-only.",
    "",
    "Tools:",
    "- The gte_* tools return one-shot, read-only snapshots fetched over HTTP, shaped as { provenance, data }; provenance records the resolved GTE environment, an ISO timestamp, the source, and the material query parameters.",
    "- Snapshots are not streams: call a tool again when fresher data is needed.",
    "- Symbol arguments accept bare tickers and resolve to canonical GTE market symbols; an ambiguous query returns an error listing the candidates.",
    "- Address-scoped tools default to the session's tracked address when one is set; otherwise pass an explicit address (0x followed by 40 hex characters).",
    "",
    "Session context:",
    `- GTE environment: ${input.gteEnv ?? "unknown"}`,
    `- Tracked address: ${input.trackedAddress ?? "none"}`,
    `- Selected market: ${input.selectedMarket ?? "none"}`,
  ].join("\n")
}

export interface Interface {
  readonly baseline: (session: SessionSchema.Info) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/SessionRunnerSystemPrompt") {}

/** Test or embedding seam for supplying a prompt builder directly. */
export const layerWith = (baseline: Interface["baseline"]) => Layer.succeed(Service, Service.of({ baseline }))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // The GTE environment comes from whichever GteData surface the composition
    // provides (the bound data service, else its config); compositions without
    // either still get the persona and per-session context.
    const data = Option.getOrUndefined(yield* Effect.serviceOption(GteData.Service))
    const config = Option.getOrUndefined(yield* Effect.serviceOption(GteData.ConfigService))
    const gteEnv = data?.env ?? config?.env
    return Service.of({
      baseline: (session) =>
        Effect.succeed(
          render({
            ...(gteEnv === undefined ? {} : { gteEnv }),
            ...(session.trackedAddress === undefined ? {} : { trackedAddress: session.trackedAddress }),
            ...(session.selectedMarket === undefined ? {} : { selectedMarket: session.selectedMarket }),
          }),
        ),
    })
  }),
)
