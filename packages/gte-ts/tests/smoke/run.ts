#!/usr/bin/env tsx
/**
 * Usage:
 *   GTE_HTTP_URL=http://localhost:8080/v1 GTE_WS_URL=ws://localhost:8080/ws pnpm test:smoke
 *   pnpm test:smoke -- --httpUrl http://localhost:8080/v1 --wsUrl ws://localhost:8080/ws
 *   pnpm test:smoke -- --client both --pk 0x... --verbose
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createGteDataClient, createGteOrderClient, fromPrivateKey } from "../../src/index.js";
import type { GteDataClient, GteOrderClient } from "../../src/index.js";

loadEnvFile(resolve(import.meta.dirname ?? ".", "../../.env.test"));
loadDevnetEnv();
import { runAllowanceTests } from "./allowance/index.smoke.js";
import { runAccountsTests } from "./data/accounts.smoke.js";
import { runMarketsTests } from "./data/markets.smoke.js";
import { runPortfolioTests } from "./data/portfolio.smoke.js";
import { runStreamsTests } from "./data/streams.smoke.js";
import { runOrderTests } from "./order/index.smoke.js";
import { resolveSmokeEndpointConfig } from "./utils/config.js";
import { printResults } from "./utils/runner.js";
import type { SuiteResult, TestConfig } from "./utils/types.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const DATA_SUITES = ["markets", "accounts", "portfolio", "streams"] as const;
type DataSuiteName = (typeof DATA_SUITES)[number];

const { values } = parseArgs({
  args,
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h", default: false },
    client: { type: "string", default: "data" },
    userAddress: { type: "string" },
    symbol: { type: "string", default: "BTC-USD-PERP" },
    timeout: { type: "string", default: "10000" },
    wsTimeout: { type: "string", default: "15000" },
    referencePrice: { type: "string" },
    delay: { type: "string", default: "0" },
    verbose: { type: "boolean", default: false },
    pk: { type: "string" },
    counterpartyAddress: { type: "string" },
    counterpartyPk: { type: "string" },
    httpUrl: { type: "string" },
    wsUrl: { type: "string" },
    dataSuites: { type: "string" },
    streamTests: { type: "string" },
  },
});

if (values.help) {
  console.log(`
gte-ts smoke tests

Usage:
  GTE_HTTP_URL=http://localhost:8080/v1 GTE_WS_URL=ws://localhost:8080/ws pnpm test:smoke
  pnpm test:smoke -- --httpUrl http://localhost:8080/v1 --wsUrl ws://localhost:8080/ws
  pnpm test:smoke -- --client both --verbose   # Run all tests with order client
  pnpm test:smoke -- --client allowance        # Run allowance regression smoke

Local devnet:
  SDK defaults point at prod. For local devnet, pass GTE_HTTP_URL/GTE_WS_URL or --httpUrl/--wsUrl.

Options:
  --client <type>      data|order|allowance|both (default: data)
  --userAddress <addr> EVM address (or GTE_USER_ADDRESS env var)
  --symbol <sym>       Market symbol (default: BTC-USD-PERP)
  --timeout <ms>       HTTP timeout (default: 10000)
  --wsTimeout <ms>     WebSocket timeout (default: 15000)
  --referencePrice <n> Reference price for devnet order placement (default: 100)
  --delay <ms>         Delay between tests (default: 0)
  --verbose            Show detailed output
  --pk <key>           Private key (or GTE_PRIVATE_KEY env var)
  --counterpartyAddress <addr> Counterparty address for order matching tests (or GTE_COUNTERPARTY_ADDRESS env var)
  --counterpartyPk <key>      Counterparty private key for order matching tests (or GTE_COUNTERPARTY_PK env var)
  --httpUrl <url>      Override HTTP base URL (or GTE_HTTP_URL env var)
  --wsUrl <url>        Override WebSocket URL (or GTE_WS_URL env var)
  --dataSuites <list>  Comma-separated data suites: markets,accounts,portfolio,streams
  --streamTests <list> Comma-separated stream tests when streams suite is selected
  -h, --help           Show this help
`);
  process.exit(0);
}

function resolveUserAddress(): string | undefined {
  return values.userAddress ?? process.env.GTE_USER_ADDRESS;
}

function resolvePrivateKey(): string | undefined {
  return values.pk ?? process.env.GTE_PRIVATE_KEY;
}

function resolveHttpUrl(): string | undefined {
  return values.httpUrl ?? process.env.GTE_HTTP_URL;
}

function resolveWsUrl(): string | undefined {
  return values.wsUrl ?? process.env.GTE_WS_URL;
}

function resolveCounterpartyAddress(): string | undefined {
  return values.counterpartyAddress ?? process.env.GTE_COUNTERPARTY_ADDRESS;
}

function resolveCounterpartyPk(): string | undefined {
  return values.counterpartyPk ?? process.env.GTE_COUNTERPARTY_PK;
}

function resolveReferencePrice(): number | undefined {
  const raw = values.referencePrice ?? process.env.GTE_SMOKE_REFERENCE_PRICE;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Error: --referencePrice must be a positive number, got '${raw}'`);
    process.exit(1);
  }
  return value;
}

function resolveStringSet(value: string | undefined): Set<string> | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return new Set(entries);
}

function validateUserAddress(): string {
  const userAddress = resolveUserAddress();
  if (!userAddress || !userAddress.startsWith("0x")) {
    console.error("Error: --userAddress or GTE_USER_ADDRESS env var must be a valid 0x address");
    process.exit(1);
  }
  return userAddress;
}

function validateClientType(): "data" | "order" | "allowance" | "both" {
  const clientType = values.client as "data" | "order" | "allowance" | "both";
  if (!["data", "order", "allowance", "both"].includes(clientType)) {
    console.error("Error: --client must be 'data', 'order', 'allowance', or 'both'");
    process.exit(1);
  }
  return clientType;
}

function validateEndpointRequirements(): { httpUrl: string; wsUrl: string } {
  try {
    return resolveSmokeEndpointConfig({
      httpUrl: resolveHttpUrl(),
      wsUrl: resolveWsUrl(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

function validateOrderClientRequirements(clientType: "data" | "order" | "allowance" | "both"): {
  pk: string | undefined;
  counterpartyPk: string | undefined;
  counterpartyAddress: string | undefined;
} {
  const needsOrderClient = clientType === "order" || clientType === "both";
  if (!needsOrderClient) {
    return {
      pk: undefined,
      counterpartyPk: undefined,
      counterpartyAddress: undefined,
    };
  }

  const pk = resolvePrivateKey();
  const counterpartyPk = resolveCounterpartyPk();
  const counterpartyAddress = resolveCounterpartyAddress();

  if (!pk) {
    console.error(
      "Error: --pk or GTE_PRIVATE_KEY env var is required when --client is 'order' or 'both'",
    );
    process.exit(1);
  }

  if (!counterpartyPk) {
    console.error(
      "Error: --counterpartyPk or GTE_COUNTERPARTY_PK env var is required when --client is 'order' or 'both'",
    );
    process.exit(1);
  }

  if (!counterpartyAddress) {
    console.error(
      "Error: --counterpartyAddress or GTE_COUNTERPARTY_ADDRESS env var is required when --client is 'order' or 'both'",
    );
    process.exit(1);
  }

  return { pk, counterpartyPk, counterpartyAddress };
}

function resolveDataSuites(): Set<DataSuiteName> {
  if (!values.dataSuites) {
    return new Set(DATA_SUITES);
  }

  const suites = new Set<DataSuiteName>();
  for (const rawSuite of values.dataSuites.split(",")) {
    const suite = rawSuite.trim();
    if (!suite) continue;
    if (!DATA_SUITES.includes(suite as DataSuiteName)) {
      console.error(`Error: unsupported --dataSuites value '${suite}'`);
      process.exit(1);
    }
    suites.add(suite as DataSuiteName);
  }

  if (suites.size === 0) {
    console.error("Error: --dataSuites must include at least one suite");
    process.exit(1);
  }

  return suites;
}

function buildTestConfig(
  userAddress: string,
  orderClientCreds: {
    pk: string | undefined;
    counterpartyPk: string | undefined;
    counterpartyAddress: string | undefined;
  },
  endpoints: {
    httpUrl: string;
    wsUrl: string;
  },
): TestConfig {
  return {
    userAddress: userAddress as `0x${string}`,
    symbol: values.symbol ?? "BTC-USD-PERP",
    timeout: Number.parseInt(values.timeout ?? "10000", 10),
    wsTimeout: Number.parseInt(values.wsTimeout ?? "15000", 10),
    referencePrice: resolveReferencePrice(),
    streamTests: resolveStringSet(values.streamTests ?? process.env.GTE_SMOKE_STREAM_TESTS),
    delay: Number.parseInt(values.delay ?? "0", 10),
    verbose: values.verbose ?? false,
    httpUrl: endpoints.httpUrl,
    wsUrl: endpoints.wsUrl,
    pk: orderClientCreds.pk as `0x${string}` | undefined,
    counterpartyAddress: orderClientCreds.counterpartyAddress as `0x${string}` | undefined,
    counterpartyPk: orderClientCreds.counterpartyPk as `0x${string}` | undefined,
  };
}

function validateArgs(): TestConfig {
  const userAddress = validateUserAddress();
  const clientType = validateClientType();
  const endpoints = validateEndpointRequirements();
  const orderClientCreds = validateOrderClientRequirements(clientType);
  return buildTestConfig(userAddress, orderClientCreds, endpoints);
}

function createDataClient(config: TestConfig): GteDataClient {
  return createGteDataClient({
    env: "hyperliquid-prod",
    httpBaseUrl: config.httpUrl,
    wsBaseUrl: config.wsUrl,
  });
}

function createOrderClient(config: TestConfig): GteOrderClient {
  if (!config.pk) throw new Error("pk required for order client");
  return createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(config.pk),
    httpBaseUrl: config.httpUrl,
    wsBaseUrl: config.wsUrl,
  });
}

async function runDataTests(
  client: GteDataClient,
  config: TestConfig,
  dataSuites: Set<DataSuiteName>,
): Promise<SuiteResult[]> {
  const results: SuiteResult[] = [];
  if (dataSuites.has("markets")) {
    results.push(await runMarketsTests(client, config));
  }
  if (dataSuites.has("accounts")) {
    results.push(await runAccountsTests(client, config));
  }
  if (dataSuites.has("portfolio")) {
    results.push(await runPortfolioTests(client, config));
  }
  if (dataSuites.has("streams")) {
    results.push(await runStreamsTests(client, config));
  }
  return results;
}

async function main() {
  const config = validateArgs();
  const clientType = values.client as "data" | "order" | "allowance" | "both";

  console.log("\ngte-ts smoke tests");
  console.log(`  symbol: ${config.symbol}`);
  console.log(`  userAddress: ${config.userAddress}`);
  console.log(`  client: ${clientType}`);
  console.log(`  httpUrl: ${config.httpUrl}`);
  console.log(`  wsUrl: ${config.wsUrl}`);

  const results: SuiteResult[] = [];

  if (clientType === "data" || clientType === "both") {
    const dataClient = createDataClient(config);
    results.push(...(await runDataTests(dataClient, config, resolveDataSuites())));
  }

  if (clientType === "order" || clientType === "both") {
    const orderClient = createOrderClient(config);
    results.push(await runOrderTests(orderClient, config));
  }

  if (clientType === "allowance") {
    results.push(await runAllowanceTests(config));
  }

  printResults(results, config.verbose);

  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
  const totalWarnings = results.reduce((sum, r) => sum + r.warnings, 0);
  if (totalWarnings > 0) {
    console.log(`\n${totalWarnings} optional test(s) failed (not blocking CI)`);
  }
  process.exit(totalFailed > 0 ? 1 : 0);
}

function loadEnvFile(filePath: string): void {
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.test is optional
  }
}

function loadDevnetEnv(): void {
  const startDir = resolve(import.meta.dirname ?? ".");
  for (const filename of [".devnet.env", ".env.devnet"]) {
    const devnetEnvPath = findFileUpward(filename, startDir);
    if (devnetEnvPath) {
      loadEnvFile(devnetEnvPath);
      return;
    }
  }
}

function findFileUpward(filename: string, startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
