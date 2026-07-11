import { createApp } from "../src/app.js";

const app = await createApp();

export default {
  fetch(request: Request, env: unknown, executionContext: unknown) {
    return app.fetch(request, env, executionContext);
  },
};
