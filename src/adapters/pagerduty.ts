import {
  isPerson,
  makeVendorAdapter,
  numericId,
  stableAlphaNumeric,
} from "./shared.js";

export const pagerdutyAdapter = makeVendorAdapter("pagerduty", ["incident"], (input) => {
  const responders = [input.actor, input.assignee, ...input.managerChain.slice(0, 2)].filter(
    isPerson,
  );
  const status =
    input.changeType === "deleted" || input.template.rawPayload.updatedStatus === "resolved"
      ? "resolved"
      : input.changeType === "updated"
        ? "acknowledged"
        : "triggered";
  const incidentId = String(
    input.template.rawPayload.incidentId ?? `P${stableAlphaNumeric(input.sourceId, 8)}`,
  );
  return {
    rawPayload: {
      id: incidentId,
      type: "incident",
      summary: input.template.title,
      title: input.template.title,
      incident_number: numericId(incidentId, 1, 99_999),
      status,
      urgency: String(input.template.rawPayload.severity ?? "sev3")
        .toLowerCase()
        .includes("sev2")
        ? "high"
        : "low",
      html_url: `https://pagerduty.example.test/incidents/${incidentId}`,
      created_at: input.occurredAt,
      updated_at: input.changeOccurredAt,
      service: pagerDutyReference(
        "service",
        input.instance.service ?? input.instance.workstream ?? "simulator-service",
      ),
      assignments: responders.map((responder) => ({
        at: input.changeOccurredAt,
        assignee: pagerDutyReference("user", responder.name, responder.id),
      })),
      acknowledgements:
        input.changeType === "created"
          ? []
          : responders
              .slice(0, 1)
              .map((responder) => ({
                at: input.changeOccurredAt,
                acknowledger: pagerDutyReference("user", responder.name, responder.id),
              })),
      escalation_policy: pagerDutyReference(
        "escalation_policy",
        `${input.scenario.department} escalation`,
        input.scenario.id,
      ),
      pending_actions:
        status === "resolved"
          ? []
          : [
              {
                type: status === "triggered" ? "acknowledge" : "resolve",
                at: input.changeOccurredAt,
              },
            ],
    },
  };
});

function pagerDutyReference(type: string, summary: string, seed = summary) {
  const id = `${type.slice(0, 3).toUpperCase()}${stableAlphaNumeric(seed, 8)}`;
  return {
    id,
    type,
    summary,
    self: `https://api.pagerduty.example.test/${type}s/${id}`,
    html_url: `https://pagerduty.example.test/${type}s/${id}`,
  };
}
