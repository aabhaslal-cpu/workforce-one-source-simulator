import { isPerson, makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const githubAdapter = makeSimpleAdapter("github", ["issue", "pull_request", "commit", "release"], (input) => ({
  repository: input.template.rawPayload.repository ?? "acme/operating-loop",
  number: input.template.rawPayload.number ?? Math.abs(Date.parse(input.occurredAt) % 1000),
  author: personPayload(input.actor),
  reviewers: [input.assignee, ...input.managerChain.slice(0, 1)].filter(isPerson).map(personPayload),
  commits: input.template.rawPayload.commits ?? [`commit-${input.sourceId.slice(-8)}`],
  reviewStatus: input.changeType === "updated" ? input.template.rawPayload.updatedReviewStatus ?? "approved" : input.template.rawPayload.reviewStatus ?? "pending",
  checks: input.changeType === "updated" ? input.template.rawPayload.updatedChecks ?? "passing" : input.template.rawPayload.checks ?? "pending",
  merged: input.template.rawPayload.merged ?? (input.changeType === "updated" && input.template.rawPayload.updatedStatus === "merged"),
  closed: input.changeType === "deleted",
  deletedBranch: input.changeType === "deleted" || input.template.rawPayload.deletedBranch === true,
  status: statusFor(input, "open"),
}));
