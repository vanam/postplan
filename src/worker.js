import { createApp } from "./api.js";
import { deleteExpiredRateLimits } from "./rate-limit.js";

export const app = createApp();

export default {
  fetch(request, env, executionContext) {
    return app.fetch(request, env, executionContext);
  },

  scheduled(_event, env, executionContext) {
    executionContext.waitUntil(deleteExpiredRateLimits(env.DB));
  }
};
