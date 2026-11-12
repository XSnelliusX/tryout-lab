import { Rpc } from "@opencode/plugin/rpc"

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })
const string = { type: "string" }
const model = object({ providerID: string, id: string, variant: string }, ["providerID", "id"])

export const Rewrite = Rpc.define({
  id: "prompt-rewrite",
  methods: {
    propose: {
      input: object({ sessionID: string, currentModel: model, text: string, model: string, requestID: string }, ["text", "requestID"]),
      output: { type: "object" },
    },
    cancel: {
      input: object({ requestID: string }, ["requestID"]),
      output: object({ cancelled: { type: "boolean" } }, ["cancelled"]),
    },
    submit: {
      input: object({ resultID: string, text: string, applyRoute: { type: "boolean" } }, ["resultID", "text", "applyRoute"]),
      output: object({ sessionID: string, queued: { type: "boolean" }, switched: { type: "boolean" } }, ["sessionID", "queued", "switched"]),
    },
  },
  events: {},
})
