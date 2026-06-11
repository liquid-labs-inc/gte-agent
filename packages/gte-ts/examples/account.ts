/**
 * Example: Fetch account data (positions, orders, balances)
 * Run with: pnpm dlx tsx examples/account.ts [address]
 */

import type { Address } from "viem";
import type { GteDataClientInterface } from "../src";
import { createGteDataClient } from "../src";

async function showBalance(client: GteDataClientInterface, userAddress: Address) {
  console.log("--- Balance ---\n");
  const balance = await client.portfolio.getBalances({ userAddress });

  const perpBalance = balance.perps[0];
  if (perpBalance) {
    console.log(`  Account Value: $${Number(perpBalance.balance).toFixed(2)}`);
  } else {
    console.log("  No perps balance found");
  }
}

async function showPositions(client: GteDataClientInterface, userAddress: Address) {
  console.log("\n--- Open Positions ---\n");
  const { positions } = await client.accounts.getPositions({ userAddress });

  if (positions.length === 0) {
    console.log("  No open positions");
    return;
  }

  for (const pos of positions) {
    console.log(`  Market ID: ${pos.marketId}`);
    console.log(`    Side: ${pos.side.toUpperCase()}`);
    console.log(`    Size: ${pos.size}`);
    console.log(`    Entry Price: $${Number(pos.entryPrice).toFixed(2)}`);
    console.log(`    Mark Price: $${Number(pos.markPrice).toFixed(2)}`);
    console.log(`    Unrealized PnL: $${Number(pos.unrealizedPnl).toFixed(2)}`);
    console.log(`    Leverage: ${pos.leverage}x (${pos.isCross ? "Cross" : "Isolated"})`);
    console.log(`    Liquidation Price: $${Number(pos.liquidationPrice).toFixed(2)}`);
    console.log();
  }
}

async function showOrders(client: GteDataClientInterface, userAddress: Address) {
  console.log("--- Open Orders ---\n");
  const { orders } = await client.accounts.getOpenOrders({ userAddress });

  if (orders.length === 0) {
    console.log("  No open orders");
    return;
  }

  for (const order of orders) {
    console.log(`  Order ID: ${order.orderId}`);
    console.log(`    Market ID: ${order.marketId}`);
    console.log(`    Side: ${order.side.toUpperCase()}`);
    console.log(`    Price: $${Number(order.limitPrice).toFixed(2)}`);
    console.log(`    Size: ${order.currentSize} / ${order.originalSize}`);
    console.log(`    Reduce Only: ${order.isReduceOnly}`);
    console.log(`    Time: ${new Date(order.timestamp).toISOString()}`);
    console.log();
  }
}

async function showFunding(client: GteDataClientInterface, userAddress: Address) {
  console.log("--- Recent Funding Payments ---\n");
  const { payments } = await client.accounts.getFundingHistory({ userAddress });

  const recentPayments = payments.slice(0, 5);
  if (recentPayments.length === 0) {
    console.log("  No funding payments");
    return;
  }

  for (const payment of recentPayments) {
    console.log(`  Market ID: ${payment.marketId}`);
    console.log(`    Rate: ${(Number(payment.fundingRate) * 100).toFixed(6)}%`);
    console.log(`    Payment: $${Number(payment.payment).toFixed(4)}`);
    console.log(`    Time: ${new Date(payment.timestamp).toISOString()}`);
    console.log();
  }
}

async function showBalanceHistory(client: GteDataClientInterface, userAddress: Address) {
  console.log("--- Balance History ---\n");
  try {
    // from: 30 days ago (in seconds)
    const from = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const history = await client.portfolio.getBalanceHistory({
      userAddress,
      from,
    });

    const perpSnapshots = history.perps.slice(0, 5);
    const spotSnapshots = history.spot.slice(0, 5);

    if (perpSnapshots.length === 0 && spotSnapshots.length === 0) {
      console.log("  No balance history");
      return;
    }

    if (perpSnapshots.length > 0) {
      console.log("  Perps:");
      for (const entry of perpSnapshots) {
        console.log(`    Time: ${new Date(entry.timestamp * 1000).toISOString()}`);
        console.log(`      Balance: $${Number(entry.balanceUsd).toFixed(2)}`);
      }
    }

    if (spotSnapshots.length > 0) {
      console.log("  Spot:");
      for (const entry of spotSnapshots) {
        console.log(`    Time: ${new Date(entry.timestamp * 1000).toISOString()}`);
        console.log(`      Balance: $${Number(entry.balanceUsd).toFixed(2)}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.log(`  Not available: ${error.message}`);
    }
  }
}

async function showPnlHistory(client: GteDataClientInterface, userAddress: Address) {
  console.log("\n--- PnL History ---\n");
  try {
    // from: 30 days ago (in seconds)
    const from = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const pnl = await client.portfolio.getPnl({
      userAddress,
      from,
    });

    const perpSnapshots = pnl.perps.slice(0, 5);
    const spotSnapshots = pnl.spot.slice(0, 5);

    if (perpSnapshots.length === 0 && spotSnapshots.length === 0) {
      console.log("  No PnL history");
      return;
    }

    if (perpSnapshots.length > 0) {
      console.log("  Perps:");
      for (const entry of perpSnapshots) {
        console.log(`    Time: ${new Date(entry.timestamp * 1000).toISOString()}`);
        console.log(`      PnL: $${Number(entry.pnlUsd).toFixed(2)}`);
      }
    }

    if (spotSnapshots.length > 0) {
      console.log("  Spot:");
      for (const entry of spotSnapshots) {
        console.log(`    Time: ${new Date(entry.timestamp * 1000).toISOString()}`);
        console.log(`      PnL: $${Number(entry.pnlUsd).toFixed(2)}`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.log(`  Not available: ${error.message}`);
    }
  }
}

async function showFees(client: GteDataClientInterface, userAddress: Address) {
  console.log("\n--- Account Fees ---\n");
  const fees = await client.accounts.getFees({ userAddress });

  console.log("  Perps:");
  console.log(`    Maker Fee: ${(fees.perps.makerFee * 100).toFixed(3)}%`);
  console.log(`    Taker Fee: ${(fees.perps.takerFee * 100).toFixed(3)}%`);
  if (fees.perps.tier) {
    console.log(`    Tier: ${fees.perps.tier}`);
  }
  if (fees.perps.volume.length > 0) {
    const latestVolume = fees.perps.volume[fees.perps.volume.length - 1];
    if (latestVolume) {
      console.log(
        `    Latest Volume: $${Number.parseFloat(latestVolume.size).toLocaleString()} (${latestVolume.date})`,
      );
    }
  }

  console.log("\n  Spot:");
  console.log(`    Maker Fee: ${(fees.spot.makerFee * 100).toFixed(3)}%`);
  console.log(`    Taker Fee: ${(fees.spot.takerFee * 100).toFixed(3)}%`);
  if (fees.spot.tier) {
    console.log(`    Tier: ${fees.spot.tier}`);
  }
}

async function showAccountMetrics(client: GteDataClientInterface, userAddress: Address) {
  console.log("\n--- Account Metrics ---\n");
  const metrics = await client.accounts.getAccountMetrics({ userAddress });

  console.log(`  Account Value: $${metrics.accountValue.toLocaleString()}`);
  console.log(`  Unrealized P&L: $${metrics.unrealizedPnl.toLocaleString()}`);
  console.log(`  Maintenance Margin: $${metrics.maintenanceMargin.toLocaleString()}`);
  console.log(`  Cross Margin Ratio: ${(metrics.crossMarginRatio * 100).toFixed(2)}%`);
  console.log(`  Total Margin Used: $${metrics.totalMarginUsed.toLocaleString()}`);
  console.log(`  Total Notional: $${metrics.totalNotional.toLocaleString()}`);
  console.log(`  Free Collateral: $${metrics.freeCollateral.toLocaleString()}`);

  const liquidationThreshold = 1.0;
  const warningThreshold = 0.7;
  const riskLevel =
    metrics.crossMarginRatio >= liquidationThreshold
      ? "CRITICAL"
      : metrics.crossMarginRatio >= warningThreshold
        ? "HIGH"
        : metrics.crossMarginRatio >= 0.5
          ? "MEDIUM"
          : "LOW";

  console.log(`\n  Risk Level: ${riskLevel}`);

  if (metrics.crossMarginRatio >= warningThreshold) {
    console.log(
      `\n⚠️  Warning: Your margin ratio is ${(metrics.crossMarginRatio * 100).toFixed(2)}%`,
    );
    console.log("  Consider reducing positions or adding more collateral to avoid liquidation.");
  }
}

async function main() {
  const client = createGteDataClient({ env: "hyperliquid-prod" });

  const userAddress = process.argv[2] as Address;

  if (!userAddress) {
    console.error("User address is required");
    process.exit(1);
  }

  console.log(`=== Account Data for ${userAddress} ===\n`);

  await showBalance(client, userAddress);
  await showPositions(client, userAddress);
  await showOrders(client, userAddress);
  await showFunding(client, userAddress);
  await showBalanceHistory(client, userAddress);
  await showPnlHistory(client, userAddress);
  await showFees(client, userAddress);
  await showAccountMetrics(client, userAddress);
}

main().catch(console.error);
