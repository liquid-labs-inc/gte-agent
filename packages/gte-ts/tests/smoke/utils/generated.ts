import { createClient, createConfig } from "../../../src/internal/generated/client/index.js";
import { setLeverage } from "../../../src/internal/generated/sdk.gen.js";
import type { SetLeverageBody } from "../../../src/internal/generated/types.gen.js";

const PLACEHOLDER_SIGNATURE =
  "0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab";

type CapturedJsonRequest = {
  body: Record<string, unknown>;
  method: string;
  pathname: string;
};

async function captureGeneratedJsonRequest(
  invoke: ReturnType<typeof createClient> extends infer TClient
    ? (client: TClient) => Promise<unknown>
    : never,
  responseBody: unknown,
): Promise<CapturedJsonRequest> {
  let captured: CapturedJsonRequest | undefined;

  const client = createClient(
    createConfig({
      baseUrl: "http://generated-smoke.invalid",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const rawBody = await request.text();

        if (rawBody.length === 0) {
          throw new Error(`Expected generated request body, got empty body for ${request.url}`);
        }

        captured = {
          body: JSON.parse(rawBody) as Record<string, unknown>,
          method: request.method,
          pathname: new URL(request.url).pathname,
        };

        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  );

  await invoke(client);

  if (!captured) {
    throw new Error("Expected generated client call to issue a request");
  }

  return captured;
}

function assertGeneratedBodyBoundary(request: CapturedJsonRequest, name: "setLeverage"): void {
  if (request.method !== "POST") {
    throw new Error(`Expected ${name} request to use POST, got ${request.method}`);
  }

  if ("traceId" in request.body || "parentSpanId" in request.body) {
    throw new Error(`Expected ${name} body to omit internal trace fields`);
  }
}

export async function assertGeneratedSetLeverageBodyShape(params: {
  leverage: number;
  subaccountId?: number;
  symbol: string;
  userAddress: string;
}): Promise<void> {
  const baseBody: SetLeverageBody = {
    symbol: params.symbol,
    leverage: params.leverage,
    subaccountId: params.subaccountId ?? 0,
    nonce: 1,
    signature: PLACEHOLDER_SIGNATURE,
  };
  const request = await captureGeneratedJsonRequest(
    (client) =>
      setLeverage({
        client,
        path: { userAddress: params.userAddress },
        body: baseBody,
      }),
    { success: true, leverage: params.leverage },
  );

  if (request.pathname !== `/accounts/${params.userAddress}/leverage`) {
    throw new Error(`Unexpected setLeverage path: ${request.pathname}`);
  }

  if ("userAddress" in request.body) {
    throw new Error("Expected setLeverage body to omit path-owned userAddress");
  }
  assertGeneratedBodyBoundary(request, "setLeverage");
}
