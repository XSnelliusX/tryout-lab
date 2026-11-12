import test from "node:test"
import assert from "node:assert/strict"
import { createService } from "../service.js"

const first = { providerID: "example", id: "alpha", variant: "medium" }
const second = { providerID: "other", id: "beta" }
const input = { sessionID: "ses_test", text: "fix only failing tests", requestID: "test-request-0001" }

async function fixture(t, options = {}) {
  const calls = []
  let session = { id: "ses_test", model: { ...first }, time: { busy: 0, idle: 1 } }
  const models = [{ ...first, variants: [{ id: "medium" }] }, { ...second, variants: [] }]
  let reply = { text: JSON.stringify({ rewritten_prompt: "Fix only the failing tests.", recommendation: { route_id: "r2", reason: "Another available model." }, warnings: [] }) }
  const ctx = {
    options: options.pluginOptions ?? {}, location: { directory: "/project" },
    session: {
      get: async () => structuredClone(session), context: async () => [],
      create: async (v) => { calls.push(["create", v]); session = { ...session, id: "ses_created", model: v.model }; return structuredClone(session) },
      switchModel: async (v) => { calls.push(["switch", v]); session.model = v.model },
      prompt: async (v) => { calls.push(["prompt", v]) },
    },
    model: { list: async () => models, default: async () => first },
    experimental: { generate: { text: async (request, requestOptions) => {
      calls.push(["generate", request, requestOptions])
      return reply
    } } },
  }
  const service = await createService(ctx, options.serviceOptions)
  t.after(() => service.dispose())
  return { service, calls, ctx, models, session, setReply: (value) => { reply = value } }
}

test("proposal uses the current model without adding a chat turn", async (t) => {
  const f = await fixture(t)
  const result = await f.service.propose(input)
  assert.equal(result.model, "example/alpha#medium")
  assert.deepEqual(f.calls[0][1].model, first)
  assert.match(f.calls[0][1].prompt, /fix only failing tests/)
  assert.deepEqual(f.calls.map(([type]) => type), ["generate"])
  await assert.rejects(f.service.propose(input), /already used/)
  await f.service.submit({ resultID: result.id, text: result.text, applyRoute: false })
  assert.equal(f.calls[1][0], "prompt")
  await assert.rejects(f.service.submit({ resultID: result.id, text: result.text, applyRoute: false }), /expired/)
})

test("configured default and request override select independently from the working model", async (t) => {
  const f = await fixture(t, { pluginOptions: { model: "other/beta" } })
  const result = await f.service.propose(input)
  assert.deepEqual(f.calls[0][1].model, second)
  assert.equal(result.model, "other/beta")
  const override = await f.service.propose({ ...input, requestID: "test-request-0002", model: "example/alpha#medium" })
  assert.equal(override.model, "example/alpha#medium")
  assert.deepEqual(f.session.model, first)
})

test("invalid or unavailable models fail without generation", async (t) => {
  await assert.rejects(createService({ options: { model: "broken" } }), /provider\/model/)
  const f = await fixture(t)
  await assert.rejects(f.service.propose({ ...input, model: "broken" }), /provider\/model/)
  await assert.rejects(f.service.propose({ ...input, model: "other/missing" }), /unavailable/)
  assert.deepEqual(f.calls, [])
})

test("explicit recommendation switches before sending", async (t) => {
  const f = await fixture(t)
  const result = await f.service.propose(input)
  assert.deepEqual(result.route, second)
  await f.service.submit({ resultID: result.id, text: result.text, applyRoute: true })
  assert.deepEqual(f.calls.map(([kind]) => kind), ["generate", "switch", "prompt"])
})

test("changed model, busy session, and edited text prevent model mutation", async (t) => {
  const f = await fixture(t)
  const result = await f.service.propose(input)
  await assert.rejects(f.service.submit({ resultID: result.id, text: "different", applyRoute: true }), /fresh/)
  f.session.model = second
  await assert.rejects(f.service.submit({ resultID: result.id, text: result.text, applyRoute: true }), /changed/)
  f.session.model = first
  f.session.time.busy = 2
  await assert.rejects(f.service.submit({ resultID: result.id, text: result.text, applyRoute: true }), /busy/)
  const sent = await f.service.submit({ resultID: result.id, text: result.text, applyRoute: false })
  assert.equal(sent.queued, true)
  assert.equal(f.calls.at(-1)[1].delivery, "queue")
})

test("bad output and provider errors do not submit or expose details", async (t) => {
  const f = await fixture(t)
  f.setReply({ text: "not json" })
  await assert.rejects(f.service.propose(input), /invalid JSON/)
  f.ctx.experimental.generate.text = async () => { throw new Error("private credential") }
  await assert.rejects(f.service.propose({ ...input, requestID: "test-request-0002" }), (error) => !error.message.includes("private credential") && /failed/.test(error.message))
  assert.deepEqual(f.calls.map(([kind]) => kind), ["generate"])
})

test("cancellation passes an abort signal and never admits a prompt", async (t) => {
  const f = await fixture(t)
  let started
  const ready = new Promise((resolve) => { started = resolve })
  f.ctx.experimental.generate.text = async (_request, { signal }) => new Promise((_resolve, reject) => {
    started(); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
  const job = f.service.propose(input)
  await ready
  assert.equal(f.service.cancel({ requestID: input.requestID }).cancelled, true)
  await assert.rejects(job, /cancelled or timed out/)
  assert.deepEqual(f.calls, [])
})

test("home screen creates no session until explicit acceptance", async (t) => {
  const f = await fixture(t)
  f.ctx.session.get = async () => { throw new Error("No session exists") }
  f.ctx.session.context = async () => { throw new Error("No context exists") }
  const result = await f.service.propose({ text: input.text, requestID: input.requestID, currentModel: first })
  assert.equal(result.sessionID, null)
  assert.deepEqual(f.calls.map(([type]) => type), ["generate"])
  const sent = await f.service.submit({ resultID: result.id, text: result.text, applyRoute: true })
  assert.equal(sent.sessionID, "ses_created")
  assert.deepEqual(f.calls.map(([type]) => type), ["generate", "create", "prompt"])
  assert.deepEqual(f.calls[1][1].model, second)
})

test("failed first prompt reuses the created session on retry", async (t) => {
  const f = await fixture(t)
  const result = await f.service.propose({ text: input.text, requestID: input.requestID, currentModel: first })
  let attempts = 0
  const prompt = f.ctx.session.prompt
  f.ctx.session.prompt = async (v) => { if (++attempts === 1) throw new Error("offline"); return prompt(v) }
  await assert.rejects(f.service.submit({ resultID: result.id, text: result.text, applyRoute: false }), /ses_created/)
  await f.service.submit({ resultID: result.id, text: result.text, applyRoute: false })
  assert.equal(f.calls.filter(([type]) => type === "create").length, 1)
})

test("concurrent acceptance is single-use", async (t) => {
  const f = await fixture(t)
  const result = await f.service.propose(input)
  let release
  f.ctx.session.get = () => new Promise((resolve) => { release = () => resolve(f.session) })
  const accepted = f.service.submit({ resultID: result.id, text: result.text, applyRoute: false })
  await assert.rejects(f.service.submit({ resultID: result.id, text: result.text, applyRoute: false }), /already being/)
  release()
  await accepted
  assert.equal(f.calls.filter(([kind]) => kind === "prompt").length, 1)
})
