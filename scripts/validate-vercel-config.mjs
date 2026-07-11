/* global URL, console */
import { existsSync, readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const srcApp = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const expectedSrcApp = 'import { createApp } from "./simulator-app.js";\n\nconst app = await createApp();\n\nexport default app;';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid vercel.json: ${message}`);
  }
}

assert(config.installCommand === "pnpm install --frozen-lockfile", "installCommand must use frozen lockfile");
assert(!("buildCommand" in config), "buildCommand must not be configured for API-only deployment");
assert(!("outputDirectory" in config), "outputDirectory must not be configured for API-only deployment");
assert(!("framework" in config), "framework override must not be configured");
const functionEntries = Object.entries(config.functions ?? {});
assert(functionEntries.length === 1, "exactly one Vercel function entrypoint must be configured");
assert(functionEntries[0]?.[0] === "src/app.ts", "src/app.ts must be the canonical Vercel function entrypoint");
const appFunctionConfig = config.functions?.["src/app.ts"] ?? {};
assert(!("runtime" in appFunctionConfig), "src/app.ts must not set a runtime");
assert(appFunctionConfig.maxDuration === 30, "src/app.ts maxDuration must be 30");
assert(appFunctionConfig.includeFiles === "migrations/*.sql", "src/app.ts must bundle migrations/*.sql");
assert(srcApp.trim() === expectedSrcApp, "src/app.ts must be the thin canonical Hono entrypoint");
assert(!existsSync(new URL("../api/index.ts", import.meta.url)), "api/index.ts must not exist");
assert(!existsSync(new URL("../src/server.ts", import.meta.url)), "src/server.ts must not exist");
assert(!("crons" in config), "crons must not be configured in vercel.json");
assert(!("rewrites" in config), "rewrites must not be configured in vercel.json");
assert(packageJson.engines?.node === "22.x", "package.json must pin Node to 22.x");
assert(packageJson.packageManager === "pnpm@9.15.9", "package.json must pin pnpm packageManager to 9.15.9");

console.log("vercel.json validated");
