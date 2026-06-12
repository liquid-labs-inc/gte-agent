import { EOL } from "os"
import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.session.commands.create,
  Effect.fn("cli.session.create")(function* (input) {
    const client = yield* (yield* Daemon.Service).client()
    const response = yield* Effect.promise(() =>
      client.session.create({
        sessionCreateRequest: {
          runtimeScope: { directory: input.directory },
          ...(Option.isSome(input.authority) ? { authorityID: input.authority.value } : {}),
        },
      }),
    )
    process.stdout.write(JSON.stringify(response.data, null, 2) + EOL)
  }),
)
