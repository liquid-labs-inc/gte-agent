import { GteAddress } from "@gte-agent/core/gte-data/address"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { GteDataSchema } from "@gte-agent/core/gte-data/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"

const unavailable = (error: GteDataSchema.RequestError) =>
  new ServiceUnavailableError({
    message: `GTE data request failed (${error.op}): ${error.message}`,
    service: "gte-data",
  })

export const gteDataHandlers = HttpApiBuilder.group(GTEAgentApi, "gteData", (handlers) =>
  Effect.gen(function* () {
    const gte = yield* GteData.Service

    const requestFailed = <A, E, R>(
      effect: Effect.Effect<A, E | GteDataSchema.RequestError, R>,
    ): Effect.Effect<A, Exclude<E, GteDataSchema.RequestError> | ServiceUnavailableError, R> =>
      effect.pipe(
        Effect.mapError((error) =>
          error instanceof GteDataSchema.RequestError
            ? unavailable(error)
            : (error as Exclude<E, GteDataSchema.RequestError>),
        ),
      )

    const address = (input: string) =>
      GteAddress.decode(input).pipe(
        Effect.mapError((error) => new InvalidRequestError({ message: error.message, field: "address" })),
      )

    /** Same resolver as the agent tools: ambiguity and misses are explicit 400s, never guesses. */
    const symbol = (query: string) =>
      gte.resolveSymbol(query).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((resolution) => {
          if (resolution.outcome === "resolved") return Effect.succeed(resolution.symbol)
          if (resolution.outcome === "ambiguous") {
            return Effect.fail(
              new InvalidRequestError({
                message: `Market symbol "${query}" is ambiguous. Candidates: ${resolution.candidates.join(", ")}.`,
                kind: "ambiguousSymbol",
                field: "symbol",
              }),
            )
          }
          return Effect.fail(
            new InvalidRequestError({
              message: `No GTE market found matching "${query}".`,
              kind: "symbolNotFound",
              field: "symbol",
            }),
          )
        }),
      )

    const optionalSymbol = (query: string | undefined) =>
      query === undefined ? Effect.succeed(undefined) : symbol(query)

    return handlers
      .handle("env", () =>
        Effect.succeed({
          env: gte.env,
          source: "http" as const,
          timestamp: new Date().toISOString(),
          validEnvs: GteDataSchema.ENV_KEYS as readonly string[],
        }),
      )
      .handle("health", () => gte.getHealth().pipe(requestFailed))
      .handle("markets", ({ query }) => {
        const snapshot: Effect.Effect<GteData.Snapshot<unknown>, GteDataSchema.RequestError> =
          query.query !== undefined && query.query.trim().length > 0
            ? gte.searchMarkets({ query: query.query.trim() })
            : gte.listMarkets({ limit: query.limit, cursor: query.cursor })
        return requestFailed(snapshot)
      })
      .handle("resolveSymbol", ({ query }) =>
        gte.resolveSymbol(query.q).pipe(
          Effect.mapError(unavailable),
          Effect.map((resolution) => ({
            provenance: {
              env: gte.env,
              source: "http" as const,
              timestamp: new Date().toISOString(),
              params: { q: query.q },
            },
            data: resolution,
          })),
        ),
      )
      .handle("market", ({ params }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) => gte.getMarket({ symbol: resolved })),
          requestFailed,
        ),
      )
      .handle("marketData", ({ params }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) => gte.getMarketData({ symbol: resolved })),
          requestFailed,
        ),
      )
      .handle("book", ({ params, query }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) => gte.getOrderBook({ symbol: resolved, limit: query.limit })),
          requestFailed,
        ),
      )
      .handle("trades", ({ params, query }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) =>
            gte.getTrades({ symbol: resolved, limit: query.limit, cursor: query.cursor }),
          ),
          requestFailed,
        ),
      )
      .handle("candles", ({ params, query }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) =>
            gte.getCandles({
              symbol: resolved,
              interval: query.interval ?? GteDataSchema.DEFAULT_CANDLE_INTERVAL,
              from: query.from ?? Date.now() - GteDataSchema.DEFAULT_CANDLE_LOOKBACK_MS,
              to: query.to,
              limit: query.limit,
            }),
          ),
          requestFailed,
        ),
      )
      .handle("context", ({ params, query }) =>
        symbol(params.symbol).pipe(
          Effect.flatMap((resolved) =>
            gte.getMarketContextHistory({
              symbol: resolved,
              from: query.from,
              to: query.to,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
          requestFailed,
        ),
      )
      .handle("quote", ({ params, query }) =>
        Effect.gen(function* () {
          const { side, baseSize, quoteSize } = query
          if ((baseSize === undefined) === (quoteSize === undefined)) {
            return yield* Effect.fail(
              new InvalidRequestError({
                message: "Provide exactly one of baseSize or quoteSize.",
                kind: "invalidQuoteSize",
              }),
            )
          }
          const resolved = yield* symbol(params.symbol)
          const snapshot =
            baseSize !== undefined
              ? yield* gte.quoteByBaseSize({ symbol: resolved, side, baseSize }).pipe(requestFailed)
              : yield* gte.quoteByQuoteSize({ symbol: resolved, side, quoteSize: quoteSize! }).pipe(requestFailed)
          return {
            provenance: snapshot.provenance,
            data: {
              symbol: resolved,
              side,
              requested: { baseSize, quoteSize },
              estimate: snapshot.data,
              note: GteDataSchema.QUOTE_ESTIMATE_NOTE,
            },
          }
        }),
      )
      .handle("positions", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getPositions({
              userAddress,
              symbol: resolved,
              subaccountId: query.subaccountId,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
          requestFailed,
        ),
      )
      .handle("openOrders", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getOpenOrders({
              userAddress,
              symbol: resolved,
              subaccountId: query.subaccountId,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
          requestFailed,
        ),
      )
      .handle("orders", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getOrders({ userAddress, symbol: resolved, cursor: query.cursor, limit: query.limit }),
          ),
          requestFailed,
        ),
      )
      .handle("tradeHistory", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getTradeHistory({
              userAddress,
              marketSymbol: resolved,
              startTime: query.startTime,
              endTime: query.endTime,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
          requestFailed,
        ),
      )
      .handle("balances", ({ params }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) => gte.getBalances({ userAddress })),
          requestFailed,
        ),
      )
      .handle("balanceHistory", ({ params, query }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) => {
            const to = query.to ?? Date.now()
            return gte.getBalanceHistory({
              userAddress,
              from: query.from ?? to - GteDataSchema.DEFAULT_HISTORY_LOOKBACK_MS,
              to,
            })
          }),
          requestFailed,
        ),
      )
      .handle("pnl", ({ params, query }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) => {
            const to = query.to ?? Date.now()
            return gte.getPnl({
              userAddress,
              from: query.from ?? to - GteDataSchema.DEFAULT_HISTORY_LOOKBACK_MS,
              to,
            })
          }),
          requestFailed,
        ),
      )
      .handle("funding", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getFundingHistory({ userAddress, symbol: resolved, cursor: query.cursor, limit: query.limit }),
          ),
          requestFailed,
        ),
      )
      .handle("account", ({ params, query }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) =>
            gte.getAccountMetrics({ userAddress, subaccountId: query.subaccountId }),
          ),
          requestFailed,
        ),
      )
      .handle("allowance", ({ params, query }) =>
        Effect.all([address(params.address), symbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getAllowance({ userAddress, symbol: resolved, subaccountId: query.subaccountId }),
          ),
          requestFailed,
        ),
      )
      .handle("leverage", ({ params, query }) =>
        Effect.all([address(params.address), symbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getLeverage({ userAddress, symbol: resolved, subaccountId: query.subaccountId }),
          ),
          requestFailed,
        ),
      )
      .handle("fees", ({ params }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) => gte.getFees({ userAddress })),
          requestFailed,
        ),
      )
      .handle("twapHistory", ({ params, query }) =>
        Effect.all([address(params.address), optionalSymbol(query.symbol)]).pipe(
          Effect.flatMap(([userAddress, resolved]) =>
            gte.getTwapHistory({ userAddress, symbol: resolved, cursor: query.cursor, limit: query.limit }),
          ),
          requestFailed,
        ),
      )
      .handle("nextSubaccount", ({ params }) =>
        address(params.address).pipe(
          Effect.flatMap((userAddress) => gte.getNextSubaccount({ userAddress })),
          requestFailed,
        ),
      )
  }),
)
