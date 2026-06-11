import type { SuiteResult, TestConfig, TestDefinition, TestResult } from "./types";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export async function runTest(definition: TestDefinition): Promise<TestResult> {
  const start = performance.now();
  try {
    await definition.fn();
    return {
      name: definition.name,
      passed: true,
      optional: definition.optional ?? false,
      duration: performance.now() - start,
    };
  } catch (err) {
    return {
      name: definition.name,
      passed: false,
      optional: definition.optional ?? false,
      error: err instanceof Error ? err.message : JSON.stringify(err),
      duration: performance.now() - start,
    };
  }
}

export async function runSuite(
  suite: string,
  tests: TestDefinition[],
  config: TestConfig,
): Promise<SuiteResult> {
  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const test of tests) {
    if (test.skip) continue;
    const result = await runTest(test);
    results.push(result);
    if (result.passed) {
      passed++;
    } else if (result.optional) {
      warnings++;
    } else {
      failed++;
    }
    if (config.delay > 0) {
      await sleep(config.delay);
    }
  }

  return { suite, tests: results, passed, failed, warnings };
}

function getTestIcon(test: TestResult): string {
  if (test.passed) return `${GREEN}✓${RESET}`;
  if (test.optional) return `${YELLOW}~${RESET}`;
  return `${RED}✗${RESET}`;
}

function getTestSuffix(test: TestResult): string {
  return !test.passed && test.optional ? " (optional)" : "";
}

function printTestResult(test: TestResult, verbose: boolean): void {
  const icon = getTestIcon(test);
  const suffix = getTestSuffix(test);
  const duration = `(${test.duration.toFixed(0)}ms)`;
  console.log(`  ${icon} ${test.name}${suffix} ${duration}`);
  if (!test.passed && (verbose || true)) {
    const color = test.optional ? YELLOW : RED;
    console.log(`    ${color}${test.error}${RESET}`);
  }
}

function printSuiteResults(suite: SuiteResult, verbose: boolean): void {
  console.log(`\n${suite.suite}`);
  for (const test of suite.tests) {
    printTestResult(test, verbose);
  }
}

function calculateTotals(results: SuiteResult[]): {
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
} {
  let totalPassed = 0;
  let totalFailed = 0;
  let totalWarnings = 0;
  for (const suite of results) {
    totalPassed += suite.passed;
    totalFailed += suite.failed;
    totalWarnings += suite.warnings;
  }
  return { totalPassed, totalFailed, totalWarnings };
}

function printSummary(totals: {
  totalPassed: number;
  totalFailed: number;
  totalWarnings: number;
}): void {
  const parts = [`${GREEN}${totals.totalPassed} passed${RESET}`];
  if (totals.totalFailed > 0) parts.push(`${RED}${totals.totalFailed} failed${RESET}`);
  if (totals.totalWarnings > 0) parts.push(`${YELLOW}${totals.totalWarnings} warnings${RESET}`);
  console.log(`\n${parts.join(", ")}`);
}

export function printResults(results: SuiteResult[], verbose: boolean): void {
  for (const suite of results) {
    printSuiteResults(suite, verbose);
  }
  const totals = calculateTotals(results);
  printSummary(totals);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_POLL_INTERVAL_MS = 250;

// Poll an async producer until a predicate holds or the timeout expires.
// On timeout the last value is returned so callers can assert a friendly error.
export async function pollUntil<T>(
  fetchValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T = await fetchValue();
  while (!predicate(latest)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return latest;
    await sleep(Math.min(intervalMs, remaining));
    latest = await fetchValue();
  }
  return latest;
}

// Run an async assertion repeatedly until it stops throwing or the timeout
// expires. If still failing at the deadline, the last thrown error is rethrown.
export async function retryUntil(
  check: () => Promise<void>,
  timeoutMs: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (true) {
    try {
      await check();
      return;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (lastError instanceof Error) throw lastError;
      throw new Error(typeof lastError === "string" ? lastError : JSON.stringify(lastError));
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}
