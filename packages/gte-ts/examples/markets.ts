/**
 * Example: List and search markets
 * Run with: pnpm dlx tsx examples/markets.ts
 */

import { createGteDataClient } from "../src";

async function main() {
  const client = createGteDataClient({ env: "hyperliquid-prod" });

  console.log("=== List Markets ===\n");

  const { markets } = await client.markets.list({ limit: 10 });
  console.log(`Found ${markets.length} markets:\n`);

  for (const market of markets) {
    console.log(`  [${market.symbol}] ${market.baseToken.symbol}/USDC`);
    console.log(`      Price: $${market.price.toFixed(2)}`);
    console.log(`      24h Change: ${market.priceChange24hr.toFixed(2)}%`);
    console.log(`      24h Volume: $${(market.volume24hrUsd / 1e6).toFixed(2)}M`);
    console.log(`      Max Leverage: ${market.marketConfig?.maxLeverage}x`);
    console.log(`      Logo: ${market.baseToken.logoUri}`);
    console.log();
  }

  console.log("\n=== Get Market by Symbol ===\n");

  const btc = await client.markets.get({ symbol: "BTC-USD" });
  console.log(`${btc.baseToken.symbol} Market Details:`);
  console.log(`  Symbol: ${btc.symbol}`);
  console.log(`  Price: $${btc.price.toFixed(2)}`);
  console.log(`  Logo: ${btc.baseToken.logoUri}`);

  const marketData = await client.markets.getData({ symbol: "BTC-USD" });
  console.log(`  Open Interest: $${(marketData.openInterest / 1e6).toFixed(2)}M`);
  console.log(`  Funding Interval: ${(btc.marketConfig?.fundingInterval ?? 0) / 3600000}h`);

  console.log("\n=== Search Markets ===\n");

  const { markets: searchMarkets } = await client.markets.search({
    query: "ETH",
  });
  console.log(`Found ${searchMarkets.length} markets matching "ETH":`);
  for (const market of searchMarkets) {
    console.log(`  [${market.symbol}] ${market.baseToken.symbol} - $${market.price.toFixed(2)}`);
  }
}

main().catch(console.error);
