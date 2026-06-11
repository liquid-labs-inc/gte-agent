export * as GteStreams from "./streams"

import { Context, Effect, Layer, Schema } from "effect"
import { createGteDataClient, type GteEnvKey, type StreamsInterface } from "gte-ts"
import type { SessionSchema } from "../session/schema"
import { ConfigService } from "./gte-data"
import { GtePanelKey } from "./panel-key"

/**
 * Read-only wrapper over the fifteen gte-ts WebSocket streams.
 *
 * This is the ONLY service in the runtime that owns a WS-connecting gte-ts
 * client. `GteData.Service` (one-shot HTTP reads) deliberately excludes the
 * `streams` surface; this sibling service constructs its own
 * `createGteDataClient` from the same `GteData.ConfigService` env and connects
 * lazily on the first subscription, so building the layer is network-free.
 *
 * The import surface stays strictly read-only: `createGteDataClient` plus
 * read/stream types. No order client, signers, or write resources.
 */

export class SubscribeError extends Schema.TaggedErrorClass<SubscribeError>()("GteStreams.SubscribeError", {
  panel: Schema.String,
  key: Schema.String,
  message: Schema.String,
}) {}

/** Cancels one active stream subscription. */
export type Unsubscribe = () => void

export type SubscribeInput = {
  readonly panel: SessionSchema.PanelType
  readonly key: string
  /** Latest payload from the stream. Raw stream data is never persisted. */
  readonly onData: (data: unknown) => void
  /** Stream-level failure; gte-ts keeps reconnecting with backoff internally. */
  readonly onError: (error: Error) => void
}

export interface Interface {
  readonly env: GteEnvKey
  readonly subscribe: (input: SubscribeInput) => Effect.Effect<Unsubscribe, SubscribeError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/GteStreams") {}

const toError = (cause: unknown): Error => (cause instanceof Error ? cause : new Error(String(cause)))

function open(streams: StreamsInterface, input: SubscribeInput): Promise<Unsubscribe> {
  const { panel, key, onData, onError } = input
  const resolved = GtePanelKey.targetFor(panel, key)
  if (!resolved.ok) return Promise.reject(new Error(resolved.reason))
  const target = resolved.target
  const handlers = { onData: (data: unknown) => onData(data), onError: (error: unknown) => onError(toError(error)) }
  switch (panel) {
    case "book":
      if (target.kind !== "market") break
      return streams.book({ params: { symbol: target.symbol }, ...handlers })
    case "trades":
      if (target.kind !== "market") break
      return streams.trades({ params: { symbol: target.symbol }, ...handlers })
    case "candles":
      if (target.kind !== "market") break
      return streams.candles(
        { params: { symbol: target.symbol, interval: target.interval ?? GtePanelKey.DEFAULT_LIVE_CANDLE_INTERVAL }, ...handlers },
      )
    case "marketData":
      if (target.kind !== "market") break
      return streams.marketData({ params: { symbol: target.symbol }, ...handlers })
    case "liquidations":
      if (target.kind !== "market") break
      return streams.liquidations({ params: { symbol: target.symbol }, ...handlers })
    case "benchMetrics":
      return streams.benchMetrics({ params: {}, ...handlers })
    case "positions":
      if (target.kind !== "address") break
      return streams.positions({ params: { userAddress: target.address }, ...handlers })
    case "openOrders":
      if (target.kind !== "address") break
      return streams.openOrders({ params: { userAddress: target.address }, ...handlers })
    case "orders":
      if (target.kind !== "address") break
      return streams.orders({ params: { userAddress: target.address }, ...handlers })
    case "orderHistory":
      if (target.kind !== "address") break
      return streams.orderHistory({ params: { userAddress: target.address }, ...handlers })
    case "funding":
      if (target.kind !== "address") break
      return streams.userFunding({ params: { userAddress: target.address }, ...handlers })
    case "balances":
      if (target.kind !== "address") break
      return streams.balances({ params: { userAddress: target.address }, ...handlers })
    case "twapHistory":
      if (target.kind !== "address") break
      return streams.twapHistory({ params: { userAddress: target.address }, ...handlers })
    case "leverage":
      if (target.kind !== "address") break
      return streams.leverageChanges({ params: { userAddress: target.address }, ...handlers })
    case "accountMetrics":
      if (target.kind !== "address") break
      return streams.accountMetrics({ params: { userAddress: target.address }, ...handlers })
  }
  return Promise.reject(new Error(`Panel ${panel} cannot stream with key "${key}"`))
}

/**
 * Build the service from a lazy `StreamsInterface` getter so the WS transport
 * is only constructed (and connected) on the first subscription.
 */
export const make = (env: GteEnvKey, getStreams: () => StreamsInterface): Interface =>
  Service.of({
    env,
    subscribe: (input) =>
      Effect.tryPromise({
        try: () => open(getStreams(), input),
        catch: (cause) =>
          new SubscribeError({ panel: input.panel, key: input.key, message: toError(cause).message }),
      }),
  })

/** Test/injection layer: bind the service to an explicit env and (stub) streams. */
export const layerFromStreams = (env: GteEnvKey, streams: StreamsInterface): Layer.Layer<Service> =>
  Layer.succeed(Service, make(env, () => streams))

/**
 * Production layer: one lazily-constructed WS client per runtime, bound to the
 * shared `GteData.ConfigService` env. Construction performs no network IO.
 */
export const layer: Layer.Layer<Service, never, ConfigService> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* ConfigService
    let streams: StreamsInterface | undefined
    return make(config.env, () => {
      streams ??= createGteDataClient({ env: config.env }).streams
      return streams
    })
  }),
)
