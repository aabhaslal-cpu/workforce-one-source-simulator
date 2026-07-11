import { makeSimpleAdapter, statusFor } from "./shared.js";

export const amplitudeAdapter = makeSimpleAdapter("amplitude", ["metric_snapshot", "funnel", "cohort"], (input) => ({
  chartId: input.template.rawPayload.chartId ?? `amp-${input.sourceId}`,
  metric: input.template.rawPayload.metric ?? "feature_adoption",
  cohort: input.template.rawPayload.cohort ?? input.instance.product,
  activeUsers: input.template.rawPayload.activeUsers ?? null,
  sevenDayChangePct: input.changeType === "updated" ? input.template.rawPayload.correctedSevenDayChangePct ?? input.template.rawPayload.sevenDayChangePct : input.template.rawPayload.sevenDayChangePct,
  conversionPct: input.template.rawPayload.conversionPct ?? null,
  delayed: input.template.visibleAfterHours !== undefined,
  corrected: input.changeType === "updated",
  precision: "simulated-directional",
  status: statusFor(input, "available"),
}));
