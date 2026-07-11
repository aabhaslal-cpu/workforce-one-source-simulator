import { z } from "zod";

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  adminLimit: number;
  connectionLimit: number;
  cronLimit: number;
  distributed: boolean;
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
    cronLimit: z.number().int().min(1).max(100_000).default(120),
    distributed: z.boolean().default(false),
  })
  .strict();

interface Bucket {
  windowStartedAt: number;
  count: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly distributedCheck?: (input: {
      scope: "admin" | "connection" | "cron";
      identityKey: string;
      limit: number;
      windowMs: number;
      nowMs: number;
    }) => Promise<RateLimitDecision | undefined>,
  ) {}

  snapshot() {
    return {
      enabled: this.config.enabled,
      windowMs: this.config.windowMs,
      activeBuckets: this.buckets.size,
      distributed: this.config.distributed,
    };
  }

  async check(scope: "admin" | "connection" | "cron", identity: string, now = Date.now()): Promise<RateLimitDecision> {
    if (!this.config.enabled) return { allowed: true };
    const limit = scope === "connection" ? this.config.connectionLimit : scope === "cron" ? this.config.cronLimit : this.config.adminLimit;
    if (this.config.distributed) {
      const distributedDecision = await this.distributedCheck?.({ scope, identityKey: identity, limit, windowMs: this.config.windowMs, nowMs: now });
      if (!distributedDecision) throw new Error("Distributed rate limiting requires a durable rate-limit store");
      return distributedDecision;
    }
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
  const productionLike = runtimeEnv === "preview" || runtimeEnv === "production";
  if (input?.trim()) {
    const parsed = RateLimitConfigSchema.parse(JSON.parse(input));
    return productionLike ? { ...parsed, distributed: true, enabled: true } : parsed;
  }
  const explicitEnabled = process.env.SIMULATOR_RATE_LIMIT_ENABLED;
  if (productionLike) return RateLimitConfigSchema.parse({ enabled: true, distributed: true });
  if (explicitEnabled === "false") return RateLimitConfigSchema.parse({ enabled: false });
  if (explicitEnabled === "true") return RateLimitConfigSchema.parse({ enabled: true });
  return RateLimitConfigSchema.parse({ enabled: productionLike, distributed: productionLike });
}
