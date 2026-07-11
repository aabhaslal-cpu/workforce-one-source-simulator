import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { createApp } from "./simulator-app.js";

const port = Number(process.env.PORT ?? 3000);
const shutdownGraceMs = Number(process.env.SIMULATOR_SHUTDOWN_GRACE_MS ?? 10_000);
const app = await createApp();
const server = serve({
  fetch: app.fetch,
  port,
}) as Server;

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ level: "error", event: "shutdown_timeout", signal }));
    process.exit(1);
  }, shutdownGraceMs);
  timeout.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await (app as typeof app & { close?: () => Promise<void> }).close?.();
  clearTimeout(timeout);
  console.log(JSON.stringify({ level: "info", event: "shutdown_complete", signal }));
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

console.log(`Workforce One Source Simulator listening on http://localhost:${port}`);
