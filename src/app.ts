import type { Hono } from "hono";
import { createApp } from "./simulator-app.js";

const app: Hono = await createApp();

export default app;
