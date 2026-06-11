import { GteApiError, GteError } from "../../errors";

type InferData<T> = T extends Promise<{ data?: infer D }> ? NonNullable<D> : never;

type HttpResult =
  | { data: unknown; error?: undefined; request: Request; response: Response }
  | { data?: undefined; error: unknown; request: Request; response: Response };

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const obj = error as { error?: unknown; message?: unknown };
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
    return JSON.stringify(error);
  }
  return String(error);
}

export async function unwrapHttpResult<T extends Promise<HttpResult>>(
  result: T,
): Promise<InferData<T>> {
  const resolved = await result;
  if (resolved.error !== undefined) {
    const message = extractErrorMessage(resolved.error);
    if (!resolved.response) {
      throw new GteError(message, "NETWORK_ERROR");
    }
    throw new GteApiError(message, resolved.error, resolved.request, resolved.response);
  }
  return resolved.data as InferData<T>;
}
