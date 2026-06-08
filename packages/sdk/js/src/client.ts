export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { GteAgentClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"

export { type Config as GTEAgentClientConfig, GteAgentClient }

export function createGTEAgentClient(config?: Config) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore fetch Request timeout is a Bun extension used by callers.
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  const client = createClient(config)
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of GTE Agent Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new GteAgentClient({ client })
}
