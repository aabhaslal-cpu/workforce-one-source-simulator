import { makeVendorAdapter, templateStatus, templateText, uuidLike } from "./shared.js";

export const notionAdapter = makeVendorAdapter(
  "notion",
  ["page", "database_item", "decision_log"],
  (input) => {
    const pageId = uuidLike(String(input.template.rawPayload.pageId ?? input.sourceId));
    const databaseId = uuidLike(
      String(input.template.rawPayload.database ?? input.instance.workstream ?? input.scenario.id),
    );
    const status = templateStatus(input, "Draft");
    const user = { object: "user", id: uuidLike(input.actor.stableKey) };
    return {
      objectType: "page",
      rawPayload: {
        object: "page",
        id: pageId,
        created_time: input.occurredAt,
        last_edited_time: input.changeOccurredAt,
        created_by: user,
        last_edited_by: user,
        archived: input.changeType === "deleted" || input.template.rawPayload.archived === true,
        in_trash: input.changeType === "deleted",
        url: `https://notion.example.test/${pageId.replaceAll("-", "")}`,
        parent: { type: "database_id", database_id: databaseId },
        properties: {
          Name: {
            id: "title",
            type: "title",
            title: [
              {
                type: "text",
                text: { content: input.template.title },
                plain_text: input.template.title,
              },
            ],
          },
          Status: {
            id: "status",
            type: "status",
            status: { name: status, color: "default" },
          },
          Summary: {
            id: "summary",
            type: "title",
            title: [
              {
                type: "text",
                text: { content: templateText(input) },
                plain_text: templateText(input),
              },
            ],
          },
        },
      },
    };
  },
);
