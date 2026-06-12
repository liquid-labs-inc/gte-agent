export type SmokeEndpointConfigInput = {
  httpUrl: string | undefined;
  wsUrl: string | undefined;
};

export type SmokeEndpointConfig = {
  httpUrl: string;
  wsUrl: string;
};

function requireEndpointUrl(
  optionName: "--httpUrl" | "--wsUrl",
  envName: "GTE_HTTP_URL" | "GTE_WS_URL",
  value: string | undefined,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${optionName} or ${envName} env var is required for gte-ts smoke tests`);
  }
  return trimmed;
}

export function resolveSmokeEndpointConfig(input: SmokeEndpointConfigInput): SmokeEndpointConfig {
  return {
    httpUrl: requireEndpointUrl("--httpUrl", "GTE_HTTP_URL", input.httpUrl),
    wsUrl: requireEndpointUrl("--wsUrl", "GTE_WS_URL", input.wsUrl),
  };
}
