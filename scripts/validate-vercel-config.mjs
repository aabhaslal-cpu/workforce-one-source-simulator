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
assert(!("runtime" in (config.functions?.["api/index.ts"] ?? {})), "api/index.ts must not set a runtime");
assert(config.functions?.["api/index.ts"]?.maxDuration === 30, "api/index.ts maxDuration must be 30");
assert(
  config.rewrites?.some((rewrite) => rewrite.source === "/(.*)" && rewrite.destination === "/api/index"),
  "all routes must rewrite to api/index",
);
assert(!("crons" in config), "crons must not be configured in vercel.json");

console.log("vercel.json validated");
