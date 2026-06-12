/**
 * Example: WebSocket streaming for real-time market data
 *
 * Run with:
 *   pnpm dlx tsx examples/streams.ts [userAddress]
 *
 * Examples:
 *   pnpm dlx tsx examples/streams.ts                           # No user streams
 *   pnpm dlx tsx examples/streams.ts 0x1234...                 # With user streams
 */

import { createGteDataClient } from "../src";

async function main() {
  const userAddress = process.argv[2];
  const bookSymbol = "BTC-USD";
  const tradesSymbol = "ETH-USD";

  // Create client
  const client = createGteDataClient({ env: "hyperliquid-prod" });

  console.log("Starting WebSocket streams demo...\n");

  // Stream order book updates
  console.log(`Subscribing to ${bookSymbol} order book...`);
  const unsubBook = await client.streams.book({
    params: { symbol: bookSymbol },
    onData: (book) => {
      console.log(`[Book] Bids: ${book.bids.length}, Asks: ${book.asks.length}`);
      if (book.bids.length > 0) {
        console.log(`  Best bid: ${book.bids[0].price}`);
      }
      if (book.asks.length > 0) {
        console.log(`  Best ask: ${book.asks[0].price}`);
      }
    },
    onError: (err) => {
      console.error("[Book Error]", err);
    },
  });

  // Stream trades
  console.log(`Subscribing to ${tradesSymbol} trades...`);
  const unsubTrades = await client.streams.trades({
    params: { symbol: tradesSymbol },
    onData: (trades) => {
      for (const trade of trades) {
        console.log(`[Trade] ${trade.side.toUpperCase()} ${trade.size} @ ${trade.price}`);
      }
    },
    onError: (err) => {
      console.error("[Trade Error]", err);
    },
  });

  // Stream market data (mark price, funding rate, open interest)
  console.log(`Subscribing to ${bookSymbol} market data...`);
  const unsubMarketData = await client.streams.marketData({
    params: { symbol: bookSymbol },
    onData: (data) => {
      console.log(
        `[MarketData] Mark: ${data.markPrice.toFixed(2)} | Mid: ${data.midPrice.toFixed(2)} | ` +
          `Funding: ${(data.fundingRate * 100).toFixed(4)}% | OI: ${data.openInterest.toFixed(2)}`,
      );
    },
    onError: (err) => {
      console.error("[MarketData Error]", err);
    },
  });

  let unsubPositions: (() => void) | null = null;
  let unsubFunding: (() => void) | null = null;
  let unsubOrders: (() => void) | null = null;

  if (userAddress) {
    console.log(`Subscribing to positions for ${userAddress}...`);
    unsubPositions = await client.streams.positions({
      params: { userAddress },
      onData: (positions) => {
        console.log(`[Positions] ${positions.length} active position(s)`);
        for (const pos of positions) {
          console.log(
            `  Market ${pos.marketId}: ${pos.side.toUpperCase()} ${
              pos.size
            } @ ${pos.entryPrice} (PnL: ${pos.unrealizedPnl})`,
          );
        }
      },
      onError: (err) => {
        console.error("[Positions Error]", err);
      },
    });

    console.log(`Subscribing to user funding for ${userAddress}...`);
    unsubFunding = await client.streams.userFunding({
      params: { userAddress },
      onData: (fundings) => {
        console.log(`[Funding] ${fundings.length} funding payment(s)`);
        for (const f of fundings) {
          console.log(`  Market ${f.marketId}: ${f.payment} USDC (rate: ${f.fundingRate})`);
        }
      },
      onError: (err) => {
        console.error("[Funding Error]", err);
      },
    });

    console.log(`Subscribing to order updates for ${userAddress}...`);
    unsubOrders = await client.streams.orders({
      params: { userAddress },
      onData: (updates) => {
        console.log(`[Orders] ${updates.length} order update(s)`);
        for (const u of updates) {
          console.log(
            `  Order ${u.order.orderId}: ${
              u.status
            } - ${u.order.side.toUpperCase()} ${u.order.currentSize} @ ${u.order.price}`,
          );
        }
      },
      onError: (err) => {
        console.error("[Orders Error]", err);
      },
    });
  } else {
    console.log("(Skipping user streams - no user address provided)");
  }

  console.log("\nStreams active. Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    unsubBook();
    unsubTrades();
    unsubMarketData();
    unsubPositions?.();
    unsubFunding?.();
    unsubOrders?.();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(console.error);
