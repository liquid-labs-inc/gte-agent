import { createGTEAgentClient } from "@gte-agent/sdk"

const client = createGTEAgentClient({
  baseUrl: process.env.GTE_AGENT_URL ?? "http://127.0.0.1:4096",
})

const created = await client.session.create({
  sessionCreateRequest: {
    runtimeScope: {
      directory: process.cwd(),
    },
  },
})

await client.session.prompt({
  sessionID: created.data.id,
  prompt: {
    text: "Say hello from the SDK example.",
  },
})

const messages = await client.session.messages({
  sessionID: created.data.id,
  order: "asc",
})

console.log(messages.data.data.map((message) => message.type))
