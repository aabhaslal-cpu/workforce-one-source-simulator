import {
  dateOnlyFromIso,
  makeVendorAdapter,
  salesforceId,
  templateStatus,
  templateText,
} from "./shared.js";

const apiVersion = "v60.0";

export const salesforceAdapter = makeVendorAdapter(
  "salesforce",
  ["account", "contact", "opportunity", "opportunity_update", "task", "event", "activity"],
  (input) => {
    if (input.template.objectType === "account") {
      const accountId = salesforceId(
        "001",
        String(input.template.rawPayload.account ?? input.instance.account ?? input.sourceId),
      );
      return {
        objectType: "Account",
        rawPayload: {
          attributes: {
            type: "Account",
            url: `/services/data/${apiVersion}/sobjects/Account/${accountId}`,
          },
          Id: accountId,
          Name: String(
            input.template.rawPayload.account ?? input.instance.account ?? input.template.title,
          ),
          OwnerId: salesforceId("005", input.actor.stableKey),
          Type: String(input.template.rawPayload.accountType ?? "Customer"),
          Industry: String(input.template.rawPayload.industry ?? "Technology"),
          BillingCountry: String(input.template.rawPayload.billingCountry ?? "United States"),
          LastModifiedDate: input.changeOccurredAt,
        },
      };
    }
    if (input.template.objectType === "contact") {
      const contactId = salesforceId("003", input.sourceId);
      const accountId = salesforceId(
        "001",
        String(input.template.rawPayload.account ?? input.instance.account ?? input.sourceId),
      );
      return {
        objectType: "Contact",
        rawPayload: {
          attributes: {
            type: "Contact",
            url: `/services/data/${apiVersion}/sobjects/Contact/${contactId}`,
          },
          Id: contactId,
          AccountId: accountId,
          OwnerId: salesforceId("005", input.actor.stableKey),
          FirstName: String(input.template.rawPayload.firstName ?? "Fictional"),
          LastName: String(input.template.rawPayload.lastName ?? "Sponsor"),
          Email: String(
            input.template.rawPayload.email ??
              `sponsor-${salesforceId("ctc", input.sourceId).toLowerCase()}@example.test`,
          ),
          Title: String(input.template.rawPayload.contactTitle ?? "Executive Sponsor"),
          LastModifiedDate: input.changeOccurredAt,
        },
      };
    }
    if (input.template.objectType === "event") {
      const eventId = salesforceId("00U", input.sourceId);
      const accountId = salesforceId(
        "001",
        String(input.template.rawPayload.account ?? input.instance.account ?? input.sourceId),
      );
      const contactId = salesforceId(
        "003",
        String(input.template.rawPayload.contact ?? input.sourceId),
      );
      const start = input.changeOccurredAt;
      return {
        objectType: "Event",
        rawPayload: {
          attributes: {
            type: "Event",
            url: `/services/data/${apiVersion}/sobjects/Event/${eventId}`,
          },
          Id: eventId,
          Subject: input.template.title,
          OwnerId: salesforceId("005", input.actor.stableKey),
          WhoId: contactId,
          WhatId: accountId,
          AccountId: accountId,
          StartDateTime: start,
          EndDateTime: new Date(Date.parse(start) + 60 * 60 * 1000).toISOString(),
          Description: templateText(input),
          LastModifiedDate: input.changeOccurredAt,
        },
      };
    }
    if (input.template.objectType === "activity" || input.template.objectType === "task") {
      const taskId = salesforceId("00T", input.sourceId);
      const whatId = salesforceId(
        "001",
        String(input.template.rawPayload.account ?? input.instance.account ?? input.sourceId),
      );
      return {
        objectType: "Task",
        rawPayload: {
          attributes: { type: "Task", url: `/services/data/${apiVersion}/sobjects/Task/${taskId}` },
          Id: taskId,
          Subject: input.template.title,
          Status: input.changeType === "updated" ? "Completed" : "In Progress",
          ActivityDate: dateOnlyFromIso(
            String(input.template.rawPayload.closeDate ?? input.changeOccurredAt),
          ),
          OwnerId: salesforceId("005", input.actor.stableKey),
          WhatId: whatId,
          Description: templateText(input),
          LastModifiedDate: input.changeOccurredAt,
        },
      };
    }
    const opportunityId = salesforceId("006", input.sourceId);
    const accountId = salesforceId(
      "001",
      String(input.template.rawPayload.account ?? input.instance.account ?? input.sourceId),
    );
    return {
      objectType: "Opportunity",
      rawPayload: {
        attributes: {
          type: "Opportunity",
          url: `/services/data/${apiVersion}/sobjects/Opportunity/${opportunityId}`,
        },
        Id: opportunityId,
        Name: input.template.title,
        AccountId: accountId,
        OwnerId: salesforceId("005", input.actor.stableKey),
        Amount:
          typeof input.template.rawPayload.amount === "number"
            ? input.template.rawPayload.amount
            : null,
        StageName: templateStatus(input, "Prospecting"),
        CloseDate:
          typeof input.template.rawPayload.updatedCloseDate === "string" &&
          input.changeType === "updated"
            ? input.template.rawPayload.updatedCloseDate
            : typeof input.template.rawPayload.closeDate === "string"
              ? input.template.rawPayload.closeDate
              : dateOnlyFromIso(input.changeOccurredAt),
        NextStep:
          typeof input.template.rawPayload.nextStep === "string"
            ? input.template.rawPayload.nextStep
            : null,
        LastModifiedDate: input.changeOccurredAt,
        Simulator_Risk_State__c:
          typeof input.template.rawPayload.riskState === "string"
            ? input.template.rawPayload.riskState
            : null,
        Simulator_Procurement_Delay__c: input.template.rawPayload.procurementDelay === true,
      },
    };
  },
);
