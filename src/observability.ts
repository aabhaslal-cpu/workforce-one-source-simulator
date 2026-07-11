export interface RequestTelemetryInput {
  requestId: string;
  method: string;
  path: string;
  operation: string;
  status: number;
  durationMs: number;
  connectionId?: string;
  worldRevision?: string;
  cursorVersion?: number;
  cursorPosition?: number;
  ledgerSequence?: number;
  errorClassification?: string;
}

export interface MetricSnapshot {
  schemaVersion: "simulator-metrics.v1";
  uptimeMs: number;
  requests: {
    total: number;
    byStatus: Record<string, number>;
    byOperation: Record<string, number>;
    recent: RequestTelemetryInput[];
  };
  latencyMs: {
    count: number;
    average: number;
    max: number;
  };
  counters: Record<string, number>;
}

export class OperationalTelemetry {
  private readonly startedAt = Date.now();
  private readonly recentRequests: RequestTelemetryInput[] = [];
  private readonly counters = new Map<string, number>();
  private latencyTotal = 0;
  private latencyMax = 0;
  private requestCounter = 0;

  constructor(private readonly logEnabled: boolean) {}

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.startedAt}-${this.requestCounter}`;
  }

  recordRequest(input: RequestTelemetryInput): void {
    this.increment("requests.total");
    this.increment(`requests.status.${input.status}`);
    this.increment(`requests.operation.${input.operation}`);
    if (input.errorClassification) this.increment(`errors.${input.errorClassification}`);
    this.latencyTotal += input.durationMs;
    this.latencyMax = Math.max(this.latencyMax, input.durationMs);
    this.recentRequests.push(input);
    if (this.recentRequests.length > 200) this.recentRequests.shift();
    if (this.logEnabled) {
      console.log(JSON.stringify({ level: input.status >= 500 ? "error" : "info", event: "request", ...input }));
    }
  }

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  snapshot(): MetricSnapshot {
    const requestCount = this.counters.get("requests.total") ?? 0;
    const counters = Object.fromEntries([...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
    return {
      schemaVersion: "simulator-metrics.v1",
      uptimeMs: Date.now() - this.startedAt,
      requests: {
        total: requestCount,
        byStatus: prefixCounters(counters, "requests.status."),
        byOperation: prefixCounters(counters, "requests.operation."),
        recent: [...this.recentRequests],
      },
      latencyMs: {
        count: requestCount,
        average: requestCount === 0 ? 0 : Math.round((this.latencyTotal / requestCount) * 100) / 100,
        max: Math.round(this.latencyMax * 100) / 100,
      },
      counters,
    };
  }
}

function prefixCounters(counters: Record<string, number>, prefix: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counters)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}
