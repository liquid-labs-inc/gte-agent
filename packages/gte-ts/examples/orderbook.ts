/**
 * Example: Fetch order book
 * Run with: pnpm dlx tsx examples/orderbook.ts
 */

import { createGteDataClient } from "../src";

async function main() {
  const client = createGteDataClient({ env: "hyperliquid-prod" });

  console.log("=== BTC-USD Order Book ===\n");

  const book = await client.markets.getOrderBook({
    symbol: "BTC-USD",
    limit: 10,
  });

  console.log("Asks (Sell orders):");
  for (const ask of book.asks.slice(0, 5).reverse()) {
    console.log(`  ${ask.price} | ${ask.qty} | ${ask.numOrders} orders`);
  }

  console.log("\n--- Spread ---\n");

  console.log("Bids (Buy orders):");
  for (const bid of book.bids.slice(0, 5)) {
    console.log(`  ${bid.price} | ${bid.qty} | ${bid.numOrders} orders`);
  }

  console.log(`\nTimestamp: ${new Date(book.timestamp).toISOString()}`);
}

main().catch(console.error);
