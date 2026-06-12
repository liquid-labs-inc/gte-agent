# Milestone 5: Read-Only GTE Data Tools

This document is the source-of-truth plan for Milestone 5 of the GTE Agent retrofit.

Milestone 5 adds read-only GTE data access to `gta` and the agent through `gte-ts`. It should expose all stable read paths from `GteDataClient`, including public market reads and explicit-address public account/portfolio reads. It must not expose signing or mutation paths.

## Goal

Add one shared read-only GTE data layer used by:

- TUI slash commands.
- Live-by-default TUI data panels.
- Agent-callable typed tools.

The same tool/data layer should power all three surfaces so behavior, provenance, configuration, and future policy are consistent.

## End State

After Milestone 5:

- `GTE_AGENT_GTE_ENV` selects the named `gte-ts` config/environment.
- Valid `GTE_AGENT_GTE_ENV` values come from `gte-ts`; GTE Agent should not own a separate URL mapping.
- The active data path imports and uses `createGteDataClient` only.
- The active data path does not import or expose `createGteOrderClient`, signer adapters, order mutation resources, or account write resources.
- Public market read commands and tools are available.
- Address-scoped account/portfolio read commands and tools are available, requiring an explicit address or session tracked address.
- A session-scoped tracked address can be set and used as the default for address-scoped reads.
- Market symbol resolution is shared by slash commands and agent tools.
- Address validation catches invalid EVM addresses before calling `gte-ts`.
- TUI data panels are live-by-default when stable `gte-ts` streams exist, and fall back to refreshable HTTP snapshots when streams are unavailable.
- Agent tools are one-shot deterministic reads, not live subscriptions.
- Slash commands open or focus the relevant live panel and record a compact one-shot snapshot in the session transcript.
- Continuous stream updates refresh panels without spamming the transcript.
- Tool outputs include provenance: `gte-ts` config/env, symbol or address, timestamp, and source type such as HTTP snapshot or WS update.
- Data panels and tool summaries do not make trading recommendations, infer actions, or generate order-like next steps.

## Read-Only Boundary

Read-only means:

- No state-changing exchange calls.
- No signing.
- No `GteOrderClient`.
- No order placement.
- No order cancel/replace.
- No TWAP creation/cancel.
- No leverage setting.
- No order preview or ready-to-submit order payload generation.

Allowed:

- Public market data reads.
- Public market streams.
- Public address-scoped account/portfolio reads.
- Public address-scoped read streams.
- Neutral derived values such as spread, mid, totals, and values returned by `gte-ts`.
- Model analysis based on fetched data.

Address-scoped data is still read-only, but it can reveal public activity tied to an address. The TUI and tools should label address-scoped reads clearly, require an explicit address or tracked address, and include the address in provenance.

## `gte-ts` Sourcing

`gte-ts` is not published yet. Until it is, Phase 1 vendors it as a workspace package:

- The authoritative source is the exchange monorepo at `packages/typescript/gte-ts` (not the stale liquid-labs copy).
- Copy the package verbatim into `packages/gte-ts`. Do not refactor or split it during vendoring; a verbatim copy keeps upstream diffs and re-syncs trivial.
- Record provenance in `packages/gte-ts/VENDORED.md`: upstream repo, path, and commit SHA at copy time. Keep the MIT license file.
- Add a sync script that diffs and refreshes the vendored copy from the upstream checkout.
- The vendored copy ships with its generated OpenAPI client and `openapi.yaml` checked in, so vendoring does not require running codegen.
- Runtime dependencies are `viem`, `@nktkas/hyperliquid`, and `valibot`; there are no transitive workspace dependencies.
- When `gte-ts` is published, replace the vendored workspace package with the published dependency. The import surface should not change.

Vendoring the whole package means the order/signing surface exists on disk inside this repo. That is intentional (Phase 2 trading execution will need it) and does not weaken the read-only boundary: the boundary is enforced at import sites — active paths import only `createGteDataClient` — and by the automated import audit below.

## Environment Configuration

GTE Agent should configure data access with:

```sh
GTE_AGENT_GTE_ENV=hyperliquid-dev
```

The set of valid names is owned by `gte-ts`. This assumption is verified: the vendored `gte-ts` exposes named environments via its `GteEnvKey` type and is constructed as `createGteDataClient({ env })`. The current valid values are `hyperliquid-dev` and `hyperliquid-prod`. GTE Agent must consume that support instead of maintaining raw HTTP/WS URL environment variables or duplicating config maps, and must not hardcode the value list — read it from the package so new environments arrive with upstream syncs.

The same configured data client must be used by:

- Slash commands.
- TUI panels.
- Agent-callable tools.
- Symbol/address resolution that calls `gte-ts`.

## Tool And Command Catalog

Use one canonical read-only data catalog. Slash commands call the same data operations as agent tools.

### Public Market Reads

- `/markets [query]`: list or search markets.
- `/market <symbol>`: market definition and summary.
- `/data <symbol>`: live market data snapshot.
- `/book <symbol>`: order book.
- `/trades <symbol>`: recent public trades.
- `/chart <symbol> [interval]`: candles/OHLCV.
- `/context <symbol>`: public market context history, if the endpoint remains stable.
- `/quote <symbol> <buy|sell> <size>`: read-only book-derived estimate.

`/quote` must be rendered as an estimate only. It must not inspect balances, check margin, create an order preview, or produce an order payload.

### Address-Scoped Reads

Commands accept an explicit address or fall back to the session tracked address:

- `/positions [address]`
- `/open-orders [address]`
- `/order-history [address]`
- `/trade-history [address]`
- `/balances [address]`
- `/balance-history [address]`
- `/pnl [address]`
- `/funding [address]`
- `/account [address]`
- `/allowance <address>`
- `/leverage <address> <symbol>`
- `/fees [address]`
- `/twap-history [address]`
- `/next-subaccount [address]`

If no address is provided and no tracked address exists, the command/tool should ask for an address instead of guessing.

### Advanced And Diagnostic Reads

Advanced or diagnostic reads should be available when the corresponding `gte-ts` surface is stable:

- `/health`: GTE data API health.
- `/liquidations <symbol>`: live public liquidations panel when stable.
- `/bench-metrics`: live benchmark/diagnostic metrics panel when stable.

These should follow the same read-only, provenance, and live-panel rules as the core commands.

### Session Tracked Address

Phase 1 should allow one session-scoped tracked address.

The tracked address:

- Is optional.
- Is a typed, validated field on the session schema (introduced in Milestone 4), settable through the canonical session API.
- Is visible in the TUI.
- Is included in session context/provenance when used.
- Is used as the default for address-scoped reads.
- Can be replaced by an authenticated user address in a later phase when real GTE auth exists.

Do not add wallet ownership, signing, ENS, or address-book behavior in Phase 1.

## Symbol Resolution

Use a shared market symbol resolver for slash commands and agent tools:

1. Exact symbol pass-through.
2. Common ticker normalization, such as uppercasing bare tickers.
3. `gte-ts` market search/list lookup.
4. LLM-assisted disambiguation only after deterministic paths fail.

LLM fallback may call read-only market search/list tools. It should not guess silently. If resolution is not confident, ask the user to disambiguate.

Outputs should show the canonical symbol returned by `gte-ts`.

## Live TUI Panels

The user should not manage WebSocket subscription IDs.

Slash commands select what the TUI watches:

- `/book BTC-USD` opens or focuses a live order book panel.
- `/trades BTC-USD` opens or focuses a live trades panel.
- `/positions 0x...` opens or focuses a live positions panel.
- `/balances 0x...` opens or focuses a live balances panel.

The runtime manages subscriptions internally:

- Use stable `gte-ts` streams when available.
- Fall back to refreshable HTTP snapshots when a stream is unavailable or unstable.
- Recreate subscriptions when reopening a session based on durable panel intent.
- Clean up subscriptions automatically when panels close, the session closes, or the TUI exits.

Transport decision: the runtime subscribes to `gte-ts` WebSocket streams internally and surfaces panel updates to the TUI over the existing SSE event channel. Do not add a new WebSocket transport between the TUI and the server, and do not expose raw `gte-ts` subscriptions to the TUI. Where a stream is shaky, the panel degrades to HTTP snapshot/refresh. The vendored `gte-ts` provides all fifteen streams listed under Stream Coverage, with built-in reconnect, liveness timeout, and backoff handling.

The durable session should store panel intent, selected market, and tracked address as the typed session schema fields introduced in Milestone 4. It should not store raw stream updates.

Phase 1 should use conservative limits:

- One primary market.
- One tracked address.
- A small fixed number of pinned panels.

These limits can become configurable later.

## Stream Coverage

Public market panels should use stable streams where available:

- Book.
- Candles.
- Trades.
- Market data.
- Liquidations and bench metrics as advanced/diagnostic panels if stable.

Address-scoped panels should use stable read streams where available:

- Positions.
- Open orders.
- Orders/order updates.
- Order history.
- User funding.
- Balances.
- TWAP history.
- Leverage changes.
- Account metrics.

If a `gte-ts` stream is unstable or unavailable, the panel should degrade to an HTTP snapshot/refresh path without exposing stream management to the user.

## Agent Tools

Agent-callable tools should be one-shot reads. They should not represent live subscriptions.

If the model needs updated data, it should call the tool again. This keeps the transcript deterministic and audit-friendly.

Model analysis is allowed in Phase 1. The model can answer trading-analysis questions based on read tools and user prompts. It must not execute trades, create order previews, or emit ready-to-submit order payloads.

## Provenance

Every transcript snapshot and tool result should include enough provenance to audit the data:

- `GTE_AGENT_GTE_ENV` or the resolved `gte-ts` config name.
- Canonical market symbol when applicable.
- Address when applicable.
- Timestamp.
- Whether the snapshot came from HTTP, WS, or a fallback refresh path.
- Any query parameters that materially shape the result, such as interval, limit, cursor, or time range.

## Out Of Scope

- Real GTE auth.
- Authenticated default address selection.
- Signing.
- Order placement, cancel, replace, or TWAP mutation.
- Leverage setting.
- Order preview.
- Account ownership verification.
- ENS or address-book behavior.
- Trading recommendations in data panel rendering.
- Final risk, approval, and execution policy.

## Implementation Checklist

1. Vendor `gte-ts` from the exchange monorepo into `packages/gte-ts` with `VENDORED.md` provenance and a sync script.
2. Add the shared read-only GTE data client configured by `GTE_AGENT_GTE_ENV`.
3. Use `gte-ts` named config support (`GteEnvKey`) as the source of truth for valid environments.
4. Add the read-only tool catalog for public market reads.
5. Add the read-only tool catalog for address-scoped account/portfolio reads.
6. Add EVM address validation for address-scoped reads.
7. Add session-scoped tracked address support on the typed session schema fields from Milestone 4.
8. Add the shared market symbol resolver.
9. Add slash commands that call the same data operations as tools.
10. Add live-by-default TUI panels fed over the existing SSE channel, with HTTP fallback.
11. Add panel intent persistence and restore.
12. Add tool/output provenance.
13. Add conservative limits for primary market, tracked address, and pinned panels.
14. Add an automated CI import audit (grep/lint) that fails if active paths import `createGteOrderClient`, signer adapters, signing helpers, or order/account write resources.
15. Verify active data paths do not import or expose mutation/signing clients.

## Risks

- Duplicating environment config in GTE Agent can drift from `gte-ts`.
- Treating address-scoped reads like authenticated account state can confuse Phase 1's no-auth boundary.
- Exposing `createGteOrderClient` or signer adapters anywhere in the active path creates an accidental mutation surface.
- Live panels can spam the transcript if stream updates are recorded as messages.
- Model-callable streaming tools would make replay and audit ambiguous.
- Symbol normalization can guess wrong if it does not use `gte-ts` search and explicit disambiguation.
- `/quote` can look like an order preview unless output is carefully limited to read-only book math.
