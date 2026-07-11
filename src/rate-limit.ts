import { z } from "zod";

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  adminLimit: number;
  connectionLimit: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

const RateLimitConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    windowMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
    adminLimit: z.number().int().min(1).max(100_000).default(600),
    connectionLimit: z.number().int().min(1).max(100_000).default(600),
  })
  .strict();

interface Bucket {
  windowStartedAt: number;
  count: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  snapshot() {
    return {
      enabled: this.config.enabled,
      windowMs: this.config.windowMs,
      activeBuckets: this.buckets.size,
    };
  }

  check(scope: "admin" | "connection", identity: string, now = Date.now()): RateLimitDecision {
    if (!this.config.enabled) return { allowed: true };
    const limit = scope === "admin" ? this.config.adminLimit : this.config.connectionLimit;
    const key = `${scope}:${identity}`;
    const current = this.buckets.get(key);
    if (!current || now - current.windowStartedAt >= this.config.windowMs) {
      this.buckets.set(key, { windowStartedAt: now, count: 1 });
      return { allowed: true };
    }
    current.count += 1;
    if (current.count <= limit) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((this.config.windowMs - (now - current.windowStartedAt)) / 1_000)),
    };
  }
}

export function buildRateLimitConfig(
  runtimeEnv: "development" | "test" | "preview" | "production",
  input: string | undefined = process.env.SIMULATOR_RATE_LIMITS,
): RateLimitConfig {
  if (input?.trim()) return RateLimitConfigSchema.parse(JSON.parse(input));
  const explicitEnabled = process.env.SIMULATOR_RATE_LIMIT_ENABLED;
  if (explicitEnabled === "false") return RateLimitConfigSchema.parse({ enabled: false });
  if (explicitEnabled === "true") return RateLimitConfigSchema.parse({ enabled: true });
  return RateLimitConfigSchema.parse({ enabled: runtimeEnv === "preview" || runtimeEnv === "production" });
}
