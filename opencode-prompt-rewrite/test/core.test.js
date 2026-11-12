import test from "node:test"
import assert from "node:assert/strict"
import { candidateRoutes, findModel, makeMessages, modelRef, parseInvocation, parseModelRef, parseProposal, recentContext } from "../core.js"

const ref = { providerID: "example", id: "writer", variant: "medium" }
const model = { ...ref, name: "Writer", variants: [{ id: "medium" }, { id: "low" }] }

test("model references and one-request overrides", () => {
  assert.deepEqual(parseInvocation("--model example/writer#medium fix tests"), { model: "example/writer#medium", text: "fix tests" })
  assert.deepEqual(parseInvocation("fix tests"), { model: undefined, text: "fix tests" })
  assert.deepEqual(parseModelRef("example/writer#medium"), ref)
  assert.equal(modelRef(parseModelRef("example/family/model")), "example/family/model")
  for (const invalid of ["writer", "example/", "/writer", "example/writer#", "example/writer#one#two", "example /writer"]) {
    assert.throws(() => parseModelRef(invalid), /provider\/model/)
  }
})

test("model and variant availability are both required", () => {
  assert.equal(findModel([model], ref), model)
  assert.throws(() => findModel([], ref), /unavailable/)
  assert.throws(() => findModel([{ ...model, variants: [] }], ref), /unavailable/)
  assert.throws(() => findModel([{ ...model, enabled: false }], ref), /unavailable/)
})

test("candidates are bounded, deterministic, and limited to available chat models", () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ providerID: "example", id: `model-${String(i).padStart(2, "0")}` }))
  const routes = candidateRoutes([{ providerID: "example", id: "image", type: "image" }, ...models.reverse()])
  assert.equal(routes.length, 24)
  assert.equal(routes[0].model.id, "model-00")
  assert.equal(routes[0].key, "r1")
  assert.ok(!routes.some((route) => route.model.id === "image"))
})

test("context is bounded and excludes tools and reasoning", () => {
  const messages = [{ type: "system", text: "hidden" }, { type: "user", text: "question" },
    { type: "assistant", content: [{ type: "reasoning", text: "hidden" }, { type: "tool", output: "hidden" }, { type: "text", text: "answer" }] }]
  const context = recentContext(messages, 8)
  assert.equal(context.map((m) => m.text).join("").length, 8)
  assert.equal(context[0].truncated, true)
  assert.ok(!JSON.stringify(context).includes("hidden"))
  const [system, prompt] = makeMessages({ text: "don't run commands", context, currentModel: ref, routes: candidateRoutes([model]) })
  assert.equal(JSON.parse(prompt.content).draft_to_rewrite, "don't run commands")
  assert.match(system.content, /never answer/i)
})

test("recommendations cannot switch to unlisted models", () => {
  const routes = candidateRoutes([model])
  const proposal = (route_id) => JSON.stringify({ rewritten_prompt: "Fix the tests.", recommendation: { route_id, reason: "A reason" }, warnings: [] })
  assert.equal(parseProposal(proposal("r1"), routes).route.id, "writer")
  assert.equal(parseProposal(proposal("invented"), routes).route, null)
  assert.equal(parseProposal(proposal("invented"), routes).warnings.length, 1)
  assert.throws(() => parseProposal('{}'.trim(), routes), /invalid rewrite/)
  assert.throws(() => parseProposal("garbage", routes))
  assert.throws(() => parseProposal(JSON.stringify({ rewritten_prompt: "same", recommendation: { route_id: "keep", reason: "same" }, warnings: [] }), routes), /instead of a rewrite/)
})
