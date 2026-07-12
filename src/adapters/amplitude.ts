import { makeVendorAdapter, numericId } from "./shared.js";

export const amplitudeAdapter = makeVendorAdapter(
  "amplitude",
  ["metric_snapshot", "funnel", "cohort", "chart_response"],
  (input) => {
    const metric = String(input.template.rawPayload.metric ?? "active_users");
    const baseValue = Number(
      input.template.rawPayload.activeUsers ?? 100 + numericId(input.sourceId, 1, 200),
    );
    const changePct = Number(
      input.changeType === "updated"
        ? (input.template.rawPayload.correctedSevenDayChangePct ??
            input.template.rawPayload.sevenDayChangePct ??
            0)
        : (input.template.rawPayload.sevenDayChangePct ?? 0),
    );
    const series = [baseValue, Math.round(baseValue * (1 + changePct / 100))];
    return {
      objectType: "chart_response",
      rawPayload: {
        data: {
          series: [series],
          seriesMeta: [String(input.template.rawPayload.cohort ?? metric)],
          xValues: [input.occurredAt.slice(0, 10), input.changeOccurredAt.slice(0, 10)],
        },
      },
    };
  },
);
