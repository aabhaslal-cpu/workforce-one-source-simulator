import { makeVendorAdapter, numericId, templateStatus, templateText } from "./shared.js";

export const zendeskAdapter = makeVendorAdapter("zendesk", ["ticket"], (input) => {
  const ticketId = numericId(
    String(input.template.rawPayload.ticketId ?? input.sourceId),
    1_000,
    900_000,
  );
  const assignee = input.assignee ?? input.actor;
  const status = zendeskStatus(
    input.changeType === "deleted" ? "closed" : templateStatus(input, "open"),
  );
  return {
    rawPayload: {
      id: ticketId,
      url: `https://support.example.test/api/v2/tickets/${ticketId}.json`,
      external_id: String(input.template.rawPayload.ticketId ?? input.sourceId),
      subject: input.template.title,
      raw_subject: input.template.title,
      description: templateText(input),
      status,
      priority: zendeskPriority(input.template.rawPayload.severity),
      type: input.template.rawPayload.escalation === true ? "incident" : "question",
      requester_id: numericId(
        String(input.template.rawPayload.account ?? input.instance.account ?? input.actor.id),
        10_000,
        90_000,
      ),
      submitter_id: numericId(input.actor.id, 10_000, 90_000),
      assignee_id: numericId(assignee.id, 10_000, 90_000),
      organization_id: numericId(
        String(input.template.rawPayload.account ?? input.instance.account ?? input.scenario.id),
        10_000,
        90_000,
      ),
      group_id: numericId(input.scenario.department, 1_000, 9_000),
      tags: [
        input.scenario.id,
        String(input.template.rawPayload.account ?? input.instance.account ?? "simulated"),
      ].map((tag) => tag.toLowerCase().replace(/[^a-z0-9_]+/g, "_")),
      custom_fields: [
        {
          id: numericId(`${input.sourceId}:severity`, 100_000, 900_000),
          value: String(input.template.rawPayload.severity ?? "normal"),
        },
        {
          id: numericId(`${input.sourceId}:escalation`, 100_000, 900_000),
          value: input.template.rawPayload.escalation === true,
        },
      ],
      created_at: input.occurredAt,
      updated_at: input.changeOccurredAt,
      comment:
        input.changeType === "updated"
          ? {
              body: String(input.template.rawPayload.comment ?? "Ticket updated."),
              public: true,
              author_id: numericId(input.actor.id, 10_000, 90_000),
            }
          : undefined,
    },
  };
});

function zendeskStatus(value: string): "new" | "open" | "pending" | "hold" | "solved" | "closed" {
  const normalized = value.toLowerCase();
  if (normalized.includes("reopened")) return "open";
  if (normalized.includes("resolved") || normalized.includes("solved")) return "solved";
  if (normalized.includes("closed")) return "closed";
  if (normalized.includes("pending")) return "pending";
  if (normalized.includes("hold")) return "hold";
  if (normalized.includes("new")) return "new";
  return "open";
}

function zendeskPriority(value: unknown): "urgent" | "high" | "normal" | "low" {
  const normalized = String(value ?? "normal").toLowerCase();
  if (normalized.includes("urgent")) return "urgent";
  if (normalized.includes("high")) return "high";
  if (normalized.includes("low")) return "low";
  return "normal";
}
