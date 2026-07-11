import { makeSimpleAdapter, personPayload, statusFor } from "./shared.js";

export const salesforceAdapter = makeSimpleAdapter("salesforce", ["account", "contact", "opportunity", "opportunity_update", "activity"], (input) => ({
  account: input.template.rawPayload.account ?? input.instance.account,
  contact: input.template.rawPayload.contact ?? "Fictional Sponsor",
  owner: personPayload(input.actor),
  amount: input.template.rawPayload.amount ?? null,
  stage: statusFor(input, "open"),
  closeDate: input.changeType === "updated" ? input.template.rawPayload.updatedCloseDate ?? input.template.rawPayload.closeDate : input.template.rawPayload.closeDate,
  segment: input.template.rawPayload.segment ?? "enterprise",
  region: input.template.rawPayload.region ?? "north-america",
  activities: input.template.rawPayload.activities ?? [],
  procurementDelay: input.template.rawPayload.procurementDelay ?? false,
  riskState: input.template.rawPayload.riskState ?? null,
}));
