# GTE TypeScript SDK Examples

Example scripts demonstrating the GTE TypeScript SDK.

## Prerequisites

```bash
# Install dependencies
pnpm install

# Build the SDK
pnpm build
```

## Running Examples

All examples use `tsx` to run TypeScript directly:

```bash
# List and search markets
pnpm dlx tsx examples/markets.ts

# Fetch orderbook data
pnpm dlx tsx examples/orderbook.ts

# Fetch account data (positions, orders, balances)
pnpm dlx tsx examples/account.ts [optional-address]

# Fetch candlestick data
pnpm dlx tsx examples/candles.ts
```

## Examples Overview

### `markets.ts`
- List available perp markets
- Get market details by ID
- Search markets by symbol

### `orderbook.ts`
- Fetch L2 orderbook for a market
- Display bids and asks
- Calculate spread

### `account.ts`
- Fetch account balance
- List open positions
- List open orders
- View funding payment history

### `candles.ts`
- Fetch OHLCV candlestick data
- Calculate period statistics (high, low, volume)

## Client Configuration

```typescript
import { createGteDataClient } from "../src";

// GTE API (default)
const client = createGteDataClient({
  httpBaseUrl: "https://api.gte.xyz/v1",
});
```
