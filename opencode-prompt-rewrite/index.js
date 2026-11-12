import { Rewrite } from "./rpc.js"
import { createService } from "./service.js"

export default {
  id: "prompt-rewrite",
  async setup(ctx) {
    const service = await createService(ctx)
    const registration = await ctx.rpc.register(Rewrite, {
      propose: (input, context) => service.propose(input, context),
      cancel: (input) => service.cancel(input),
      submit: (input) => service.submit(input),
    })
    return async () => { service.dispose(); await registration.dispose() }
  },
}
