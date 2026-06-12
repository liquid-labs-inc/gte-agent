/**
 * Example: Fetch candlestick data
 * Run with: pnpm dlx tsx examples/candles.ts
 */

import { createGteDataClient } from "../src";

async function main() {
  const client = createGteDataClient({ env: "hyperliquid-prod" });

  console.log("=== BTC-USD Candles (Last 24h, 1h interval) ===\n");

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  const candles = await client.markets.getCandles({
    symbol: "BTC-USD",
    from: oneDayAgo,
    interval: "1h",
    limit: 24,
  });

  console.log("Time                    | Open      | High      | Low       | Close     | Volume");
  console.log("-".repeat(90));

  for (const candle of candles.slice(-10)) {
    const time = new Date(candle.timestamp).toISOString().replace("T", " ").slice(0, 19);
    console.log(
      `${time} | ${candle.open.toFixed(2).padStart(9)} | ${candle.high.toFixed(2).padStart(9)} | ${candle.low.toFixed(2).padStart(9)} | ${candle.close.toFixed(2).padStart(9)} | ${candle.volume.toFixed(2)}`,
    );
  }
}

main().catch(console.error);
