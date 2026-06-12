import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.session.commands.list,
  Effect.fn("cli.session.list")(function* () {
    const client = yield* (yield* Daemon.Service).client()
    const response = yield* Effect.promise(() => client.session.list())
    process.stdout.write(JSON.stringify(response.data, null, 2) + EOL)
  }),
)
