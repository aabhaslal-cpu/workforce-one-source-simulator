import { dateOnlyFromIso, makeVendorAdapter, templateStatus, uuidLike } from "./shared.js";

export const gainsightAdapter = makeVendorAdapter(
  "gainsight",
  ["health_score", "cta", "success_plan", "milestone"],
  (input) => {
    const objectName = gainsightObjectName(input.template.objectType);
    const score =
      input.changeType === "updated" && typeof input.template.rawPayload.updatedScore === "number"
        ? input.template.rawPayload.updatedScore
        : typeof input.template.rawPayload.score === "number"
          ? input.template.rawPayload.score
          : undefined;
    const rawPayload: Record<string, unknown> = {
      objectName,
      GSID: uuidLike(input.sourceId),
      Name: input.template.title,
      CompanyId: uuidLike(
        String(input.template.rawPayload.account ?? input.instance.account ?? input.scenario.id),
      ),
      OwnerId: uuidLike(input.actor.stableKey),
      Status: templateStatus(input, objectName === "ScorecardMeasure" ? "Current" : "Open"),
      DueDate: dateOnlyFromIso(input.changeOccurredAt),
      LastModifiedDate: input.changeOccurredAt,
      CustomFields: {
        Simulator_Risk_Reason__c:
          typeof input.template.rawPayload.riskReason === "string"
            ? input.template.rawPayload.riskReason
            : null,
        Simulator_Milestone__c:
          typeof input.template.rawPayload.milestone === "string"
            ? input.template.rawPayload.milestone
            : null,
      },
    };
    if (score !== undefined) {
      rawPayload.Score = score;
      rawPayload.Trend = String(
        input.template.rawPayload.trend ?? (input.changeType === "updated" ? "changed" : "stable"),
      );
    }
    return { objectType: objectName, rawPayload };
  },
);

function gainsightObjectName(
  objectType: string,
): "CallToAction" | "SuccessPlan" | "ScorecardMeasure" | "TimelineActivity" {
  if (objectType === "cta") return "CallToAction";
  if (objectType === "success_plan") return "SuccessPlan";
  if (objectType === "milestone" || objectType === "health_score") return "ScorecardMeasure";
  return "TimelineActivity";
}
