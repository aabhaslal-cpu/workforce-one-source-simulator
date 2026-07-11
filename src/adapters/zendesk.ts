import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const zendeskAdapter = makeSimpleAdapter("zendesk", ["ticket"], (input) => ({
  ticketId: input.template.rawPayload.ticketId ?? `ZD-${input.sourceId.slice(-6)}`,
  requester: input.template.rawPayload.requester ?? input.instance.account,
  assignee: input.assignee ? personPayload(input.assignee) : personPayload(input.actor),
  severity: input.template.rawPayload.severity ?? "normal",
  comments: input.changeType === "updated" ? [input.template.rawPayload.comment ?? "Ticket updated."] : [],
  escalation: input.template.rawPayload.escalation ?? false,
  linkedAccount: input.template.rawPayload.account ?? input.instance.account,
  reopened: input.template.rawPayload.updatedStatus === "reopened",
  resolved: input.template.rawPayload.updatedStatus === "resolved",
  redacted: input.changeType === "deleted" || input.template.rawPayload.redacted === true,
  status: statusFor(input, "open"),
}));
