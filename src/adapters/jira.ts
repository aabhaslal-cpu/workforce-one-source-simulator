import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const jiraAdapter = makeSimpleAdapter("jira", ["epic", "story", "task", "bug", "issue"], (input) => ({
  projectKey: input.template.rawPayload.projectKey ?? "OPS",
  issueKey: input.template.rawPayload.issueKey ?? `OPS-${Math.abs(Date.parse(input.occurredAt) % 9000)}`,
  issueType: input.template.objectType,
  reporter: personPayload(input.actor),
  assignee: input.assignee ? personPayload(input.assignee) : null,
  priority: input.template.rawPayload.priority ?? "Medium",
  sprint: input.template.rawPayload.sprint ?? input.instance.project,
  dueDate: input.template.rawPayload.dueDate ?? null,
  dependencies: input.template.rawPayload.dependencies ?? [],
  comments: input.changeType === "updated" ? [input.template.rawPayload.comment ?? "Status updated after cross-functional discussion."] : [],
  changelog: [{ at: input.changeOccurredAt, status: statusFor(input, "open") }],
  archived: input.changeType === "deleted",
  status: statusFor(input, "open"),
}));
