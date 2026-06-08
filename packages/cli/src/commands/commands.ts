import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

declare const GTE_AGENT_CLI_NAME: string | undefined

export const Commands = Spec.make(typeof GTE_AGENT_CLI_NAME === "string" ? GTE_AGENT_CLI_NAME : "gte-agent", {
  description: "GTE Agent command line interface",
  commands: [
    Spec.make("service", {
      description: "Manage the background server",
      commands: [
        Spec.make("start", { description: "Start the background server" }),
        Spec.make("restart", { description: "Restart the background server" }),
        Spec.make("status", { description: "Show background server status" }),
        Spec.make("stop", { description: "Stop the background server" }),
        Spec.make("password", {
          description: "Get or set the server password",
          params: { value: Argument.string("value").pipe(Argument.optional) },
        }),
      ],
    }),
    Spec.make("session", {
      description: "Manage local sessions",
      commands: [
        Spec.make("create", {
          description: "Create a session",
          params: {
            directory: Flag.string("directory").pipe(Flag.withDefault(process.cwd())),
            authority: Flag.string("authority").pipe(Flag.optional),
          },
        }),
        Spec.make("list", { description: "List sessions" }),
        Spec.make("prompt", {
          description: "Admit a prompt",
          params: {
            session: Argument.string("session"),
            text: Argument.string("text"),
          },
        }),
        Spec.make("events", {
          description: "Stream session events",
          params: {
            session: Argument.string("session"),
            after: Flag.string("after").pipe(Flag.optional),
          },
        }),
        Spec.make("messages", {
          description: "Replay session messages",
          params: {
            session: Argument.string("session"),
            order: Flag.string("order").pipe(Flag.optional),
            limit: Flag.integer("limit").pipe(Flag.optional),
          },
        }),
      ],
    }),
    Spec.make("serve", {
      description: "Start the GTE Agent API server",
      params: {
        hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
        port: Flag.integer("port").pipe(Flag.optional),
        register: Flag.boolean("register").pipe(Flag.withDefault(false)),
      },
    }),
  ],
})
