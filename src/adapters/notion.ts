import { isPerson, makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const notionAdapter = makeSimpleAdapter("notion", ["page", "database_item", "decision_log"], (input) => ({
  pageId: input.template.rawPayload.pageId ?? `notion-${input.sourceId}`,
  workspace: input.template.rawPayload.workspace ?? "Acme Ops",
  database: input.template.rawPayload.database ?? input.instance.workstream,
  owner: personPayload(input.actor),
  editors: [input.actor, input.assignee, ...input.managerChain.slice(0, 2)].filter(isPerson).map(personPayload),
  body: input.template.rawPayload.body ?? input.template.rawPayload.summary ?? input.template.title,
  restricted: input.template.acl.visibility === "restricted" || input.template.rawPayload.restricted === true,
  archived: input.changeType === "deleted" || input.template.rawPayload.archived === true,
  lastEditedTime: input.changeOccurredAt,
  status: statusFor(input, "draft"),
}));
