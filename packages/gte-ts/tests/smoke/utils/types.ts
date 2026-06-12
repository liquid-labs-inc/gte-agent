export type TestConfig = {
  userAddress: `0x${string}`;
  symbol: string;
  timeout: number;
  wsTimeout: number;
  delay: number;
  verbose: boolean;
  referencePrice?: number;
  streamTests?: Set<string>;
  httpUrl: string;
  wsUrl: string;
  pk?: `0x${string}`;
  counterpartyAddress?: `0x${string}`;
  counterpartyPk?: `0x${string}`;
};

export type TestDefinition = {
  id?: string;
  name: string;
  fn: () => Promise<void>;
  optional?: boolean;
  skip?: boolean;
};

export type TestResult = {
  name: string;
  passed: boolean;
  optional: boolean;
  error?: string;
  duration: number;
};

export type SuiteResult = {
  suite: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  warnings: number;
};
