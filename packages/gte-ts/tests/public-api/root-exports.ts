import {
  type GteDataClientOptions,
  type GteEnvKey,
  type GteHttpOptions,
  type GteOrderClientOptions,
  type GteSigner,
  type SetLeverageBody,
  type SetLeverageRequest,
  createGteDataClient,
  createGteOrderClient,
  getHealth,
  getMarkets,
} from "gte-ts";

export const setLeverageRequest: SetLeverageRequest = {
  symbol: "BTC-USD",
  leverage: 10,
  subaccountId: 0,
  nonce: 1,
  signature: "0x0",
};

export const setLeverageBody: SetLeverageBody = setLeverageRequest;

const env: GteEnvKey = "hyperliquid-dev";
const signer = {} as GteSigner;

export const dataClientOptions: GteDataClientOptions = {
  env,
};

export const orderClientOptions: GteOrderClientOptions = {
  env: "hyperliquid-prod",
  signer,
};

export const httpOptions: GteHttpOptions = {
  env,
};

createGteDataClient(dataClientOptions);
createGteOrderClient(orderClientOptions);
getHealth(httpOptions);
getMarkets(undefined, httpOptions);

// @ts-expect-error env is required for data clients
const missingDataClientEnv: GteDataClientOptions = {};
void missingDataClientEnv;

// @ts-expect-error env is required for order clients
const missingOrderClientEnv: GteOrderClientOptions = { signer };
void missingOrderClientEnv;

// @ts-expect-error env is required for HTTP helpers
const missingHttpEnv: GteHttpOptions = {};
void missingHttpEnv;

// @ts-expect-error source is internal and is not accepted by data client options
const dataClientSourceOption: GteDataClientOptions = { env, source: "hyperliquid" };
void dataClientSourceOption;

// @ts-expect-error source is internal and is not accepted by order client options
const orderClientSourceOption: GteOrderClientOptions = { env, signer, source: "hyperliquid" };
void orderClientSourceOption;

// @ts-expect-error source is internal and is not accepted by HTTP helper options
const httpSourceOption: GteHttpOptions = { env, source: "hyperliquid" };
void httpSourceOption;

// @ts-expect-error data clients require an env options object
createGteDataClient();

// @ts-expect-error order clients require env in addition to signer
createGteOrderClient({ signer });

// @ts-expect-error HTTP helpers require an env options object
getHealth();
