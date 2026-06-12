import { LLMClient, LLMEvent, Model } from "@gte-agent/llm"
import * as OpenAIChat from "@gte-agent/llm/protocols/openai-chat"
import { Effect, Layer, Stream } from "effect"
import { SystemContextRegistry } from "../../system-context-registry"
import { ToolRegistry } from "../../tool/registry"
import * as SessionRunnerLLM from "./llm"
import { SessionRunnerModel } from "./model"

const demoModel = Model.make({ id: "gte-agent-demo", provider: "gte-agent-demo", route: OpenAIChat.route })

export const modelLayer = SessionRunnerModel.layerWith(() => Effect.succeed(demoModel))

export const clientLayer = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("The deterministic demo client does not prepare provider requests"),
    stream: () =>
      Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "demo-text" }),
        LLMEvent.textDelta({ id: "demo-text", text: "GTE Agent demo response." }),
        LLMEvent.textEnd({ id: "demo-text" }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: {
            inputTokens: 0,
            outputTokens: 4,
            totalTokens: 4,
          },
        }),
        LLMEvent.finish({ reason: "stop" }),
      ]),
    generate: () => Effect.die("The deterministic demo client only supports streaming"),
  }),
)

export const layer = SessionRunnerLLM.layer.pipe(
  Layer.provide(clientLayer),
  Layer.provide(modelLayer),
  Layer.provide(ToolRegistry.emptyLayer),
  Layer.provide(SystemContextRegistry.layer),
)
