import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.js",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["LEGACY_DB"],
        bindings: {
          TEST_MIGRATIONS: JSON.stringify(migrations),
          POSTPLAN_BOOTSTRAP_API_KEY: "test-bootstrap-key",
          POSTPLAN_PUBLIC_BASE_URL: "https://postplan.test",
          POSTPLAN_SESSION_SECRET: "test-session-secret-with-at-least-32-bytes",
          SHOO_BASE_URL: "https://shoo.test"
        }
      }
    })
  ],
  test: {
    setupFiles: ["./test/setup.js"]
  }
});
