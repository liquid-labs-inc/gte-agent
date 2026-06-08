import { EOL } from "os"
import { Option } from "effect"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Daemon } from "../../../services/daemon"

export default Runtime.handler(
  Commands.commands.session.commands.events,
  Effect.fn("cli.session.events")(function* (input) {
    const client = yield* (yield* Daemon.Service).client()
    yield* Effect.promise(async () => {
      const response = await client.session.events({
        sessionID: input.session,
        ...(Option.isSome(input.after) ? { after: input.after.value } : {}),
      })
      for await (const event of response.stream) {
        process.stdout.write((typeof event === "string" ? event : JSON.stringify(event)) + EOL)
      }
    })
  }),
)
