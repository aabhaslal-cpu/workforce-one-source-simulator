import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const gainsightAdapter = makeSimpleAdapter("gainsight", ["health_score", "cta", "success_plan", "milestone"], (input) => ({
  account: input.template.rawPayload.account ?? input.instance.account,
  owner: personPayload(input.actor),
  managerVisibleTo: input.managerChain.slice(0, 2).map(personPayload),
  dimensions: input.template.rawPayload.dimensions ?? { adoption: "unknown", support: "unknown", sponsor: "unknown" },
  score: input.changeType === "updated" ? input.template.rawPayload.updatedScore ?? input.template.rawPayload.score : input.template.rawPayload.score,
  stale: input.template.rawPayload.stale ?? false,
  riskReason: input.template.rawPayload.riskReason ?? null,
  milestone: input.template.rawPayload.milestone ?? null,
  closedCta: input.template.rawPayload.closedCta ?? input.changeType === "deleted",
  status: statusFor(input, "open"),
}));
