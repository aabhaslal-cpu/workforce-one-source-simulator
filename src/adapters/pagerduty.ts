import { isPerson, makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const pagerdutyAdapter = makeSimpleAdapter("pagerduty", ["incident"], (input) => ({
  incidentId: input.template.rawPayload.incidentId ?? `PD-${input.sourceId.slice(-6)}`,
  severity: input.template.rawPayload.severity ?? "sev3",
  responders: [input.actor, input.assignee, ...input.managerChain.slice(0, 2)].filter(isPerson).map(personPayload),
  timeline: [{ at: input.changeOccurredAt, event: input.changeType }],
  acknowledged: input.changeType !== "created",
  reassignedTo: input.changeType === "updated" && input.assignee ? personPayload(input.assignee) : null,
  escalated: input.template.rawPayload.escalated ?? input.managerChain.length > 1,
  resolved: input.template.rawPayload.updatedStatus === "resolved",
  postmortemLink: input.template.rawPayload.postmortemLink ?? null,
  status: statusFor(input, "triggered"),
}));
