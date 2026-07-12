import {
  dateOnlyFromIso,
  jiraAccountId,
  makeVendorAdapter,
  numericId,
  templateStatus,
  templateText,
} from "./shared.js";

export const jiraAdapter = makeVendorAdapter(
  "jira",
  ["epic", "story", "task", "bug", "issue"],
  (input) => {
    const projectKey = String(input.template.rawPayload.projectKey ?? "OPS").toUpperCase();
    const issueKey = String(
      input.template.rawPayload.issueKey ?? `${projectKey}-${numericId(input.sourceId, 100, 9000)}`,
    );
    const issueId = String(numericId(issueKey, 10_000, 90_000));
    const status = templateStatus(input, "Open");
    const issueType = issueTypeName(input.template.objectType);
    const assignee = input.assignee
      ? {
          self: `https://jira.example.test/rest/api/3/user?accountId=${jiraAccountId(input.assignee)}`,
          accountId: jiraAccountId(input.assignee),
          emailAddress: input.assignee.email,
          displayName: input.assignee.name,
          active: true,
        }
      : null;
    const reporter = {
      self: `https://jira.example.test/rest/api/3/user?accountId=${jiraAccountId(input.actor)}`,
      accountId: jiraAccountId(input.actor),
      emailAddress: input.actor.email,
      displayName: input.actor.name,
      active: true,
    };
    return {
      objectType: "issue",
      rawPayload: {
        expand: "renderedFields,names,schema,operations,editmeta,changelog",
        id: issueId,
        self: `https://jira.example.test/rest/api/3/issue/${issueId}`,
        key: issueKey,
        fields: {
          summary: input.template.title,
          issuetype: { id: String(numericId(issueType, 1, 99)), name: issueType },
          project: {
            id: String(numericId(projectKey, 10_000, 90_000)),
            key: projectKey,
            name: `${projectKey} project`,
          },
          status: { name: status, statusCategory: statusCategory(status) },
          priority: { name: String(input.template.rawPayload.priority ?? "Medium") },
          reporter,
          assignee,
          created: input.occurredAt,
          updated: input.changeOccurredAt,
          duedate:
            typeof input.template.rawPayload.dueDate === "string"
              ? input.template.rawPayload.dueDate
              : dateOnlyFromIso(input.changeOccurredAt),
          labels: [input.scenario.id, input.instance.workstream ?? input.scenario.department].map(
            (label) => String(label).replace(/[^A-Za-z0-9_-]+/g, "-"),
          ),
          description: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: templateText(input) }] },
            ],
          },
          customfield_10020: [
            {
              name: String(
                input.template.rawPayload.sprint ?? input.instance.project ?? "Simulation Sprint",
              ),
            },
          ],
        },
        changelog: {
          histories: [
            {
              id: String(numericId(`${input.sourceId}:history`, 1_000, 9_000)),
              created: input.changeOccurredAt,
              author: reporter,
              items: [
                {
                  field: "status",
                  fromString:
                    input.changeType === "created"
                      ? null
                      : String(input.template.rawPayload.status ?? "Open"),
                  toString: status,
                },
              ],
            },
          ],
        },
      },
    };
  },
);

function issueTypeName(objectType: string): string {
  if (objectType === "epic") return "Epic";
  if (objectType === "story") return "Story";
  if (objectType === "bug") return "Bug";
  if (objectType === "task") return "Task";
  return "Task";
}

function statusCategory(status: string): { key: string; name: string } {
  const normalized = status.toLowerCase();
  if (["done", "closed", "resolved", "deferred"].some((value) => normalized.includes(value)))
    return { key: "done", name: "Done" };
  if (
    ["in review", "in progress", "blocked", "at risk"].some((value) => normalized.includes(value))
  )
    return { key: "indeterminate", name: "In Progress" };
  return { key: "new", name: "To Do" };
}
