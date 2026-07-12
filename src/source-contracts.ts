import type { SourceSystem } from "./domain.js";

export const SOURCE_PAYLOAD_CONTRACT_VERSION = "source-payload-contract.v6";
export const SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT = "2026-07-11";

export type SourceContractFidelityStatus = "verified" | "partially_verified";

export interface SourceContractFamily {
  family: string;
  description: string;
  requiredFields: string[];
  lifecycleSemantics: string[];
  customFields?: string[];
  limitations?: string[];
}

export interface SourceContractManifest {
  sourceSystem: SourceSystem;
  contractVersion: typeof SOURCE_PAYLOAD_CONTRACT_VERSION;
  providerApi: string;
  retrievedAt: typeof SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT;
  fidelityStatus: SourceContractFidelityStatus;
  docs: string[];
  families: SourceContractFamily[];
  limitations: string[];
}

export const sourceContractManifests: SourceContractManifest[] = [
  {
    sourceSystem: "slack",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Slack Events API message event",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: ["https://docs.slack.dev/reference/events/message/"],
    families: [
      {
        family: "message",
        description:
          "Slack message event payloads, including message_changed and message_deleted subtypes.",
        requiredFields: ["type", "channel", "user", "text", "ts", "event_ts", "channel_type"],
        lifecycleSemantics: [
          "created uses a normal message event",
          "updated uses subtype message_changed",
          "deleted uses subtype message_deleted",
        ],
      },
    ],
    limitations: [
      "The simulator emits a supported subset of Events API fields and does not emulate Slack authorization scopes or enterprise grid envelopes.",
    ],
  },
  {
    sourceSystem: "gmail",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Gmail API v1 users.messages and users.threads",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: [
      "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages",
      "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads",
      "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash",
      "https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete",
    ],
    families: [
      {
        family: "message",
        description: "Gmail Message resource with headers and labelIds.",
        requiredFields: ["id", "threadId", "labelIds", "snippet", "payload", "internalDate"],
        lifecycleSemantics: [
          "created appears as a message",
          "internalDate and RFC 2822 Date header remain tied to original message creation time",
          "updated changes labels/snippet",
          "trash is represented as an updated Message with TRASH label",
          "permanent delete keeps the last-known Message payload and uses the outer simulator changeType",
        ],
      },
      {
        family: "thread",
        description: "Gmail Thread resource with embedded message resources.",
        requiredFields: ["id", "historyId", "messages"],
        lifecycleSemantics: ["thread records use the same message subset inside messages"],
      },
    ],
    limitations: [
      "MIME bodies are intentionally minimal and deterministic. Gmail history records are not emitted as a rawPayload family; incremental behavior is represented by the simulator source-change ledger. users.messages.delete returns an empty response body, so destructive deletes copy the preceding projected Message payload and are represented by the outer simulator changeType.",
    ],
  },
  {
    sourceSystem: "calendar",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Google Calendar API v3 Events resource",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: ["https://developers.google.com/workspace/calendar/api/v3/reference/events"],
    families: [
      {
        family: "event",
        description: "Calendar Event resource.",
        requiredFields: [
          "kind",
          "id",
          "status",
          "summary",
          "organizer",
          "attendees",
          "start",
          "end",
        ],
        lifecycleSemantics: [
          "created/updated use confirmed or tentative status",
          "deleted uses cancelled status",
        ],
      },
    ],
    limitations: [
      "Recurrence rules are represented only when scenario templates request recurrence.",
    ],
  },
  {
    sourceSystem: "notion",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Notion API pages",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: ["https://developers.notion.com/reference/page"],
    families: [
      {
        family: "page",
        description: "Notion Page object with parent, properties, and archive flags.",
        requiredFields: [
          "object",
          "id",
          "created_time",
          "last_edited_time",
          "created_by",
          "last_edited_by",
          "parent",
          "archived",
          "in_trash",
          "properties",
        ],
        lifecycleSemantics: [
          "updated changes properties/last_edited_time",
          "deleted uses archived and in_trash flags",
        ],
      },
    ],
    limitations: [
      "Scenario labels such as decision_log and database_item canonicalize to the Notion Page object. Blocks, databases, and comments are not emitted as rawPayload families.",
    ],
  },
  {
    sourceSystem: "jira",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Jira Cloud REST API v3 issue resource",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: ["https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/"],
    families: [
      {
        family: "issue",
        description: "Jira issue resource with fields and changelog.",
        requiredFields: ["id", "key", "self", "fields"],
        lifecycleSemantics: [
          "issue status names are workflow configured",
          "updates include changelog histories",
          "deleted changes retain the last fictional issue view while the top-level changeType marks deletion",
        ],
        customFields: ["customfield_10020"],
      },
    ],
    limitations: [
      "Workflow status names are tenant configurable in Jira; the simulator uses common fictional workflow names.",
    ],
  },
  {
    sourceSystem: "productboard",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Productboard API v2 Entities and Notes GET responses",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "partially_verified",
    docs: [
      "https://developer.productboard.com/reference/introduction",
      "https://developer.productboard.com/openapi/entities.yaml",
      "https://developer.productboard.com/reference/getnote",
      "https://developer.productboard.com/reference/migration-guide",
      "https://developer.productboard.com/reference/listnoterelationships",
      "https://developer.productboard.com/reference/createnoterelationship",
    ],
    families: [
      {
        family: "feature",
        description: "Productboard Entities API GET response subset for feature entities.",
        requiredFields: [
          "data.id",
          "data.type",
          "data.fields",
          "data.relationships",
          "data.links",
          "data.createdAt",
          "data.updatedAt",
        ],
        lifecycleSemantics: [
          "feature status is workspace configured",
          "archive is represented as an updated feature with fields.archived true",
          "permanent delete copies the preceding projected feature payload and uses the outer simulator changeType",
        ],
      },
      {
        family: "note",
        description: "Productboard Notes API GET response subset for textNote records.",
        requiredFields: [
          "data.id",
          "data.type",
          "data.fields",
          "data.relationships",
          "data.links",
          "data.createdAt",
          "data.updatedAt",
        ],
        lifecycleSemantics: [
          "note type is represented by data.type textNote",
          "archive is represented as an updated note with fields.archived true",
          "permanent delete copies the preceding projected note payload and uses the outer simulator changeType",
        ],
      },
    ],
    limitations: [
      "Productboard fields and feature statuses are workspace configurable, so the simulator marks the provider subset as partially verified. Productboard permanent delete endpoints return 204 No Content, so destructive deletes copy the preceding projected Productboard GET-style payload and are represented by the outer simulator changeType.",
    ],
  },
  {
    sourceSystem: "amplitude",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Amplitude Dashboard REST API active/new user count response",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: ["https://amplitude.com/docs/apis/analytics/dashboard-rest"],
    families: [
      {
        family: "chart_response",
        description: "Dashboard REST API active/new user count response subset with series data.",
        requiredFields: ["data.series", "data.seriesMeta", "data.xValues"],
        lifecycleSemantics: [
          "updates correct the returned series values while preserving chart identity",
        ],
      },
    ],
    limitations: ["The simulator emits deterministic aggregate responses, not raw event exports."],
  },
  {
    sourceSystem: "github",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "GitHub REST API 2022-11-28",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: [
      "https://docs.github.com/en/rest",
      "https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28",
      "https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28",
      "https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28",
      "https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28",
    ],
    families: [
      {
        family: "pull_request",
        description: "REST pull request object subset.",
        requiredFields: [
          "id",
          "node_id",
          "number",
          "state",
          "title",
          "user",
          "head",
          "base",
          "html_url",
        ],
        lifecycleSemantics: [
          "updates can close or merge pull requests",
          "deletes are represented by top-level changeType rather than a fabricated raw deleted flag",
        ],
      },
      {
        family: "issue",
        description: "REST issue object subset.",
        requiredFields: [
          "id",
          "node_id",
          "number",
          "state",
          "title",
          "user",
          "labels",
          "assignees",
          "html_url",
        ],
        lifecycleSemantics: ["updates change state/labels/comments"],
      },
      {
        family: "commit",
        description: "REST commit object subset.",
        requiredFields: ["sha", "node_id", "commit", "author", "committer", "parents"],
        lifecycleSemantics: [
          "commit updates are represented as a new current commit object for the same simulator source identity",
          "commit deletions use the outer simulator changeType because the REST commit resource has no delete status",
        ],
      },
      {
        family: "release",
        description: "REST release object subset.",
        requiredFields: [
          "id",
          "node_id",
          "tag_name",
          "target_commitish",
          "draft",
          "prerelease",
          "author",
        ],
        lifecycleSemantics: [
          "published releases use published_at",
          "deleted release changes copy the preceding projected release payload and use the outer simulator changeType",
        ],
      },
    ],
    limitations: [
      "Webhook envelopes and GraphQL-only fields are out of scope for the feed payload subset.",
    ],
  },
  {
    sourceSystem: "pagerduty",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "PagerDuty REST API incident resource",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: [
      "https://developer.pagerduty.com/api-reference/",
      "https://developer.pagerduty.com/api-reference/9d0b4b12e36f9-list-incidents",
      "https://developer.pagerduty.com/api-reference/005299ed43553-get-an-incident",
      "https://developer.pagerduty.com/api-reference/a7d81b0e9200f-create-an-incident",
      "https://developer.pagerduty.com/api-reference/8a0e1aa2ec666-update-an-incident",
    ],
    families: [
      {
        family: "incident",
        description: "PagerDuty incident object subset.",
        requiredFields: [
          "id",
          "type",
          "summary",
          "status",
          "urgency",
          "service",
          "assignments",
          "created_at",
        ],
        lifecycleSemantics: ["status uses triggered, acknowledged, or resolved"],
      },
    ],
    limitations: ["Escalation policies and services are deterministic fictional references."],
  },
  {
    sourceSystem: "salesforce",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Salesforce REST API sObject resources",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: [
      "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/intro_rest.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_sobject_retrieve_get.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_account.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_contact.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_opportunity.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_task.htm",
      "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_event.htm",
    ],
    families: [
      {
        family: "Account",
        description: "Salesforce Account sObject subset.",
        requiredFields: ["attributes", "Id", "Name", "OwnerId"],
        lifecycleSemantics: [
          "Account updates change LastModifiedDate and current field values; destructive deletes use outer changeType.",
        ],
      },
      {
        family: "Contact",
        description: "Salesforce Contact sObject subset.",
        requiredFields: ["attributes", "Id", "AccountId", "OwnerId", "LastName"],
        lifecycleSemantics: [
          "Contact updates change LastModifiedDate and current field values; destructive deletes use outer changeType.",
        ],
      },
      {
        family: "Opportunity",
        description: "Salesforce Opportunity sObject subset.",
        requiredFields: [
          "attributes",
          "Id",
          "Name",
          "AccountId",
          "OwnerId",
          "StageName",
          "CloseDate",
        ],
        lifecycleSemantics: [
          "StageName carries opportunity state",
          "custom simulator-only fields are namespaced as Salesforce custom fields",
        ],
        customFields: ["Simulator_Risk_State__c", "Simulator_Procurement_Delay__c"],
      },
      {
        family: "Task",
        description: "Salesforce Task sObject subset.",
        requiredFields: [
          "attributes",
          "Id",
          "Subject",
          "Status",
          "ActivityDate",
          "OwnerId",
          "WhatId",
        ],
        lifecycleSemantics: [
          "Status uses common task values such as Not Started, In Progress, Completed, or Deferred",
        ],
      },
      {
        family: "Event",
        description: "Salesforce Event sObject subset.",
        requiredFields: [
          "attributes",
          "Id",
          "Subject",
          "OwnerId",
          "WhoId",
          "WhatId",
          "StartDateTime",
          "EndDateTime",
        ],
        lifecycleSemantics: [
          "Event time and participant relationships are represented by sObject fields.",
        ],
      },
    ],
    limitations: [
      "The simulator does not emulate Salesforce describe metadata or org-specific required fields.",
    ],
  },
  {
    sourceSystem: "gainsight",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Gainsight NXT API and Developer Docs",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "partially_verified",
    docs: [
      "https://support.gainsight.com/gainsight_nxt/API_and_Developer_Docs",
      "https://support.gainsight.com/gainsight_nxt/API_and_Developer_Docs/Cockpit_API/Call_To_Action_(CTA)_API_Documentation",
      "https://support.gainsight.com/gainsight_nxt/API_and_Developer_Docs/Success_Plan_APIs/Success_Plan_APIs",
      "https://support.gainsight.com/gainsight_nxt/API_and_Developer_Docs/Timeline_API/Timeline_APIs",
      "https://support.gainsight.com/gainsight_nxt/API_and_Developer_Docs/Customer_Goals_API/Customer_Goals_APIs",
    ],
    families: [
      {
        family: "CallToAction",
        description: "Gainsight CTA-style object subset.",
        requiredFields: ["objectName", "GSID", "Name", "Status", "CompanyId", "OwnerId"],
        lifecycleSemantics: ["CTA state is carried by Status"],
      },
      {
        family: "SuccessPlan",
        description: "Gainsight Success Plan-style object subset.",
        requiredFields: ["objectName", "GSID", "Name", "Status", "CompanyId", "OwnerId"],
        lifecycleSemantics: ["Success plan state is carried by Status"],
      },
      {
        family: "ScorecardMeasure",
        description: "Gainsight scorecard measure-style object subset.",
        requiredFields: ["objectName", "GSID", "CompanyId", "Score"],
        lifecycleSemantics: ["Score updates change Score/Trend fields"],
      },
      {
        family: "TimelineActivity",
        description: "Gainsight Timeline activity-style object subset used for milestone records.",
        requiredFields: [
          "objectName",
          "GSID",
          "Type",
          "ActivityDate",
          "Body",
          "CompanyId",
          "OwnerId",
        ],
        lifecycleSemantics: [
          "Milestone records are represented as TimelineActivity entries, not scorecard measures.",
        ],
      },
    ],
    limitations: [
      "Exact Gainsight object schemas are tenant configurable and some docs are gated; custom scenario fields are isolated under CustomFields.",
    ],
  },
  {
    sourceSystem: "zendesk",
    contractVersion: SOURCE_PAYLOAD_CONTRACT_VERSION,
    providerApi: "Zendesk Ticketing API",
    retrievedAt: SOURCE_PAYLOAD_CONTRACT_RETRIEVED_AT,
    fidelityStatus: "verified",
    docs: [
      "https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/",
      "https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/",
      "https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_audits/",
      "https://developer.zendesk.com/api-reference/ticketing/ticket-management/incremental_exports/",
    ],
    families: [
      {
        family: "ticket",
        description: "Zendesk ticket object subset with comment and custom_fields arrays.",
        requiredFields: [
          "id",
          "url",
          "subject",
          "status",
          "priority",
          "requester_id",
          "submitter_id",
          "assignee_id",
          "created_at",
          "updated_at",
        ],
        lifecycleSemantics: [
          "status uses Zendesk ticket statuses",
          "updates may include a comment object",
        ],
      },
    ],
    limitations: [
      "Deleted-ticket exports are not modeled as a separate family in Milestone 3; top-level changeType carries destructive simulator changes.",
    ],
  },
];

export const sourceContractManifestBySystem = new Map(
  sourceContractManifests.map((manifest) => [manifest.sourceSystem, manifest]),
);
