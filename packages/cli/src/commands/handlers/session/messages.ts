import { EOL } from "os"
import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.session.commands.messages,
  Effect.fn("cli.session.messages")(function* (input) {
    const client = yield* (yield* Daemon.Service).client()
    const response = yield* Effect.promise(() =>
      client.session.messages({
        sessionID: input.session,
        ...(Option.isSome(input.order) && (input.order.value === "asc" || input.order.value === "desc")
          ? { order: input.order.value }
          : {}),
        ...(Option.isSome(input.limit) ? { limit: String(input.limit.value) } : {}),
      }),
    )
    process.stdout.write(JSON.stringify(response.data, null, 2) + EOL)
  }),
)
