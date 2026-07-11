import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const gmailAdapter = makeSimpleAdapter("gmail", ["email", "thread"], (input) => ({
  threadId: input.template.rawPayload.threadId ?? `thread-${input.sourceId}`,
  messageId: `msg-${input.sourceId}-${input.changeType}`,
  sender: personPayload(input.actor),
  recipients: [input.assignee ?? input.managerChain[0] ?? input.actor].filter(Boolean).map(personPayload),
  cc: input.managerChain.slice(1, 3).map(personPayload),
  subject: input.template.rawPayload.subject ?? input.template.title,
  labels: input.template.rawPayload.labels ?? [input.scenario.department, input.instance.workstream],
  unread: input.template.rawPayload.unread ?? input.changeType === "created",
  forwardedContext: input.template.rawPayload.forwardedContext ?? null,
  archived: input.template.rawPayload.archived ?? false,
  deleted: input.changeType === "deleted",
  status: statusFor(input, "sent"),
}));
