import { Rewrite } from "./rpc.js"
import { createService } from "./service.js"

export default {
  id: "prompt-rewrite",
  async setup(ctx) {
    let registration
    const service = await createService(ctx, {
      onProgress: (event) => {
        try {
          void registration?.events?.emit?.("progress", event)?.catch?.(() => {})
        } catch {
          // Best-effort live progress notification.
        }
      },
    })
    registration = await ctx.rpc.register(Rewrite, {
      grill: (input, context) => service.grill(input, context),
      rewrite: (input, context) => service.rewrite(input, context),
      cancel: (input) => service.cancel(input),
      dismiss: (input) => service.dismiss(input),
      inspect: (input) => service.inspect(input),
      submit: (input) => service.submit(input),
      jobs: (input) => service.jobs(input),
      models: () => service.models(),
    })
    return async () => {
      service.dispose()
      await registration.dispose()
    }
  },
}
