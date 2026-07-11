/* global URL, console */
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid vercel.json: ${message}`);
  }
}

assert(config.installCommand === "pnpm install --frozen-lockfile", "installCommand must use frozen lockfile");
assert(config.buildCommand === "pnpm run build", "buildCommand must run the TypeScript build");
assert(config.functions?.["api/index.ts"]?.runtime === "nodejs22.x", "api/index.ts must use nodejs22.x");
assert(config.functions?.["api/index.ts"]?.maxDuration === 30, "api/index.ts maxDuration must be 30");
assert(
  config.rewrites?.some((rewrite) => rewrite.source === "/(.*)" && rewrite.destination === "/api/index"),
  "all routes must rewrite to api/index",
);
assert(
  config.crons?.some((cron) => cron.path === "/api/cron/tick" && cron.schedule === "*/5 * * * *"),
  "cron must target /api/cron/tick",
);

console.log("vercel.json validated");
