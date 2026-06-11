/**
 * Example: Place, cancel, and modify orders
 * Run with: pnpm dlx tsx examples/orders.ts
 *
 * NOTE: This example uses a mock private key and will fail authentication.
 * Replace PRIVATE_KEY with a real private key to test actual trading.
 */

import type { CancelOrderRequest, NewOrderRequest, ReplaceOrderRequest } from "../src";
import { createGteOrderClient, fromPrivateKey } from "../src";

//  Replace with real key to test actual trading
const PRIVATE_KEY = "0x..." as const;

const basePlaceholder = {
  account: "",
  signature: "",
  subaccountId: 0 as const,
};

async function placeOrder() {
  console.log("--- Place Limit Order ---\n");

  const client = createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(PRIVATE_KEY),
  });

  // Place a single limit buy order
  const order: NewOrderRequest = {
    ...basePlaceholder,
    clientOrderId: Date.now(),
    symbol: "BTC-USD",
    side: "buy",
    type: "limit",
    price: 50000, // Limit price in USD
    quantity: 0.001, // Size in base currency
    reduceOnly: false,
    timeInForce: "goodTilCancel",
  };

  const result = await client.orders.create([order]);
  console.log("Order result:", JSON.stringify(result, null, 2));
  return result;
}

async function placeMultipleOrders() {
  console.log("\n--- Place Multiple Orders ---\n");

  const client = createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(PRIVATE_KEY),
  });

  // Place multiple orders at once (more efficient than separate calls)
  const orders: NewOrderRequest[] = [
    {
      ...basePlaceholder,
      clientOrderId: Date.now(),
      symbol: "BTC-USD",
      side: "buy",
      type: "limit",
      price: 48000,
      quantity: 0.001,
      reduceOnly: false,
      timeInForce: "goodTilCancel",
    },
    {
      ...basePlaceholder,
      clientOrderId: Date.now() + 1,
      symbol: "BTC-USD",
      side: "sell",
      type: "limit",
      price: 52000,
      quantity: 0.001,
      reduceOnly: false,
      timeInForce: "goodTilCancel",
    },
    {
      ...basePlaceholder,
      clientOrderId: Date.now() + 2,
      symbol: "ETH-USD",
      side: "buy",
      type: "limit",
      price: 3000,
      quantity: 0.01,
      reduceOnly: false,
      timeInForce: "immediateOrCancel",
    },
  ];

  const result = await client.orders.create(orders);
  console.log("Orders result:", JSON.stringify(result, null, 2));
  return result;
}

async function cancelOrders() {
  console.log("\n--- Cancel Orders ---\n");

  const client = createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(PRIVATE_KEY),
  });

  // Cancel orders by order ID
  const cancelRequest: CancelOrderRequest = {
    ...basePlaceholder,
    clientOrderId: Date.now(),
    symbol: "BTC-USD",
    side: "buy",
    origClientOrderId: 12345, // Replace with actual order ID
  };

  const result = await client.orders.cancel([cancelRequest]);
  console.log("Cancel result:", JSON.stringify(result, null, 2));
  return result;
}

async function modifyOrder() {
  console.log("\n--- Modify Order ---\n");

  const client = createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(PRIVATE_KEY),
  });

  // Modify an existing limit order (change price/size)
  const replaceRequest: ReplaceOrderRequest = {
    ...basePlaceholder,
    clientOrderId: Date.now(),
    symbol: "BTC-USD",
    originalClientOrderId: 12345, // The order ID to modify
    side: "buy",
    type: "limit",
    price: 49000, // New price
    quantity: 0.002, // New size
  };

  const result = await client.orders.replace([replaceRequest]);
  console.log("Modify result:", JSON.stringify(result, null, 2));
  return result;
}

async function placeReduceOnlyOrder() {
  console.log("\n--- Place Reduce-Only Order ---\n");

  const client = createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(PRIVATE_KEY),
  });

  // Reduce-only orders can only decrease position size
  // Useful for take-profit/stop-loss that shouldn't flip position
  const order: NewOrderRequest = {
    ...basePlaceholder,
    clientOrderId: Date.now(),
    symbol: "BTC-USD",
    side: "sell",
    type: "limit",
    price: 55000,
    quantity: 0.001,
    reduceOnly: true, // This order can only reduce position
    timeInForce: "goodTilCancel",
  };

  const result = await client.orders.create([order]);
  console.log("Reduce-only order result:", JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  console.log("=== Order Examples ===\n");
  console.log("NOTE: Using mock private key - orders will fail authentication.\n");
  console.log("Replace PRIVATE_KEY with a real key to test actual trading.\n");

  try {
    await placeOrder();
    await placeMultipleOrders();
    await cancelOrders();
    await modifyOrder();
    await placeReduceOnlyOrder();
  } catch (error) {
    console.error("\nError:", error);
  }
}

main().catch(console.error);
