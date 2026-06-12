export class GteError extends Error {
  public readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "GteError";
    this.code = code;
  }
}

export class GteApiError<TError = unknown> extends GteError {
  public readonly error: TError;
  public readonly request: Request;
  public readonly response: Response;

  constructor(message: string, error: TError, request: Request, response?: Response) {
    const safeResponse =
      response ??
      new Response(null, {
        status: 520,
        statusText: "NETWORK_ERROR",
      });
    super(message, `HTTP_${safeResponse.status}`);
    this.name = "GteApiError";
    this.error = error;
    this.request = request;
    this.response = safeResponse;
  }

  get status(): number {
    return this.response.status;
  }
}

export function createHlApiError(error: unknown, baseUrl: string): GteApiError {
  const message = error instanceof Error ? error.message : String(error);
  return new GteApiError(
    message,
    error,
    new Request(baseUrl),
    new Response(JSON.stringify({ error }), { status: 500 }),
  );
}
