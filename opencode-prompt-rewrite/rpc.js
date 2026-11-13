import { Rpc } from "@opencode/plugin/rpc"

const object = (properties, required = [], additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
})

const string = { type: "string" }
const number = { type: "number" }
const boolean = { type: "boolean" }

const usageSummary = object(
  {
    providerID: string,
    modelID: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    reasoningTokens: number,
    totalTokens: number,
    costUSD: number,
    estimated: boolean,
    billing: string,
  },
  ["inputTokens", "outputTokens", "totalTokens", "costUSD", "estimated"],
)

const model = object({ providerID: string, id: string, variant: string }, ["providerID", "id"])

const grillAnswer = object({
  questionID: string,
  question: string,
  selectedLabels: { type: "array", items: string },
  customText: string,
}, ["questionID"])

export const Rewrite = Rpc.define({
  id: "prompt-rewrite",
  methods: {
    grill: {
      input: object(
        {
          sessionID: string,
          targetKey: string,
          currentModel: model,
          text: string,
          model: string,
          requestID: string,
        },
        ["text", "requestID"],
      ),
      output: { type: "object" },
    },
    rewrite: {
      input: object(
        {
          sessionID: string,
          targetKey: string,
          currentModel: model,
          text: string,
          model: string,
          requestID: string,
          grillID: string,
          answers: { type: "array", items: grillAnswer },
          previousRewrite: string,
          refineInstruction: string,
        },
        ["text", "requestID"],
      ),
      output: { type: "object" },
    },
    cancel: {
      input: object({ requestID: string, targetKey: string }, []),
      output: object({ cancelled: boolean }, ["cancelled"]),
    },
    submit: {
      input: object(
        {
          resultID: string,
          text: string,
          applyRoute: boolean,
          selectedModel: model,
        },
        ["resultID", "text", "applyRoute"],
      ),
      output: object(
        {
          sessionID: string,
          queued: boolean,
          switched: boolean,
        },
        ["sessionID", "queued", "switched"],
      ),
    },
    jobs: {
      input: object({ targetKey: string }, []),
      output: { type: "object" },
    },
    models: {
      input: object({}, []),
      output: { type: "object" },
    },
  },
  events: {
    progress: {
      schema: object(
        {
          requestID: string,
          targetKey: string,
          sessionID: string,
          status: string,
          phase: string,
          detail: string,
          model: string,
          startedAt: number,
          updatedAt: number,
          error: string,
          usage: usageSummary,
        },
        ["requestID", "targetKey", "status", "phase", "detail", "startedAt", "updatedAt"],
      ),
    },
  },
})
