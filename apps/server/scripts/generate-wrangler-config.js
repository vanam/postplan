#!/usr/bin/env node
/**
 * Generate an environment-specific Wrangler config from environment variables.
 *
 * Reads:
 *   POSTPLAN_DOMAIN_<ENV>
 *   POSTPLAN_D1_DATABASE_ID_<ENV>
 *
 * Merges overrides into wrangler.jsonc and writes wrangler.<env>.jsonc.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "jsonc-parser";

const environment = process.argv[2] ?? "production";
const environmentSuffix = environment.toUpperCase();
const domainVariable = `POSTPLAN_DOMAIN_${environmentSuffix}`;
const databaseIdVariable = `POSTPLAN_D1_DATABASE_ID_${environmentSuffix}`;
const domain = process.env[domainVariable];
const databaseId = process.env[databaseIdVariable];

if (!domain) {
  throw new Error(`Missing ${domainVariable}`);
}

if (!databaseId) {
  throw new Error(`Missing ${databaseIdVariable}`);
}

const name = environment === "production" ? "postplan" : `postplan-${environment}`;
const baseConfig = parse(readFileSync("wrangler.jsonc", "utf8"));
const config = {
  ...baseConfig,
  name,
  d1_databases: [
    {
      binding: "DB",
      database_name: name,
      database_id: databaseId,
      migrations_dir: "migrations"
    }
  ],
  vars: {
    ...baseConfig.vars,
    POSTPLAN_PUBLIC_BASE_URL: `https://${domain}`
  },
  routes: [
    {
      pattern: domain,
      custom_domain: true
    }
  ]
};

const outputPath = `wrangler.${environment}.jsonc`;
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Generated ${outputPath}`);
