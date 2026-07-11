import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const productboardAdapter = makeSimpleAdapter("productboard", ["feature", "insight", "component"], (input) => ({
  featureId: input.template.rawPayload.featureId ?? `pb-${input.sourceId}`,
  productArea: input.template.rawPayload.productArea ?? input.instance.product,
  owner: personPayload(input.actor),
  linkedCustomerFeedback: input.template.rawPayload.customer ? [input.template.rawPayload.customer] : [input.instance.account],
  priorityNote: input.template.rawPayload.priorityNote ?? input.template.rawPayload.summary ?? null,
  roadmapPosition: input.template.rawPayload.roadmapPosition ?? "candidate",
  dependencyNote: input.template.rawPayload.dependencyNote ?? null,
  archived: input.changeType === "deleted" || input.template.rawPayload.archived === true,
  status: statusFor(input, "under_review"),
}));
