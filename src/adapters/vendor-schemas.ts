import { z } from "zod";
import type { SourceSystem } from "../domain.js";
export { SOURCE_PAYLOAD_CONTRACT_VERSION } from "../source-contracts.js";
import type { ValidationResult } from "./types.js";

const isoDateTime = z.string().datetime();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const urlString = z.string().url();

export const SIMULATOR_METADATA_KEYS = [
  "provider",
  "sourceId",
  "objectType",
  "lifecycle",
  "actor",
  "assignee",
  "managementChain",
  "scenarioId",
  "scenarioPackId",
  "scenarioInstanceId",
  "businessEventId",
  "templateId",
  "seedFingerprint",
  "scenarioTime",
  "changeOccurredAt",
  "providerFields",
  "context",
  "simulatorSourceId",
  "simulatorScenarioPackId",
  "simulatorScenarioInstanceId",
  "simulatorVersion",
  "simulatorUpdatedAt",
  "simulatorDeletedAt",
  "simulatorMalformedPayload",
  "simulatorDeletedObject",
  "simulatorEditedObject",
  "simulatorLateArrivingObject",
  "actorPersonId",
  "actorEmail",
  "assigneePersonId",
  "assigneeEmail",
  "tombstone",
  "deleted",
] as const;

const simulatorMetadataKeySet = new Set<string>(SIMULATOR_METADATA_KEYS);

export function simulatorMetadataPaths(value: unknown, path = "rawPayload"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => simulatorMetadataPaths(item, `${path}[${index}]`));
  }
  const paths: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenSimulatorMetadataKey(key, path)) {
      paths.push(`${path}.${key}`);
    }
    paths.push(...simulatorMetadataPaths(nested, `${path}.${key}`));
  }
  return paths;
}

function isForbiddenSimulatorMetadataKey(key: string, path: string): boolean {
  if (key.startsWith("simulator")) return true;
  if (key === "actor" || key === "assignee" || key === "deleted") return path === "rawPayload";
  return simulatorMetadataKeySet.has(key);
}

export function assertNoSimulatorMetadata(value: unknown): ValidationResult {
  const paths = simulatorMetadataPaths(value);
  return {
    ok: paths.length === 0,
    errors: paths.map((path) => `rawPayload contains simulator metadata at ${path}`),
  };
}

const slackMessageSchema = z
  .object({
    type: z.literal("message"),
    channel: z.string().regex(/^[CDG][A-Z0-9]{8,}$/),
    user: z
      .string()
      .regex(/^U[A-Z0-9]{8,}$/)
      .optional(),
    bot_id: z
      .string()
      .regex(/^B[A-Z0-9]{8,}$/)
      .optional(),
    text: z.string(),
    ts: z.string().regex(/^\d{10}\.\d{6}$/),
    event_ts: z.string().regex(/^\d{10}\.\d{6}$/),
    channel_type: z.enum(["channel", "group", "im", "mpim"]),
    thread_ts: z
      .string()
      .regex(/^\d{10}\.\d{6}$/)
      .optional(),
    subtype: z.enum(["message_changed", "message_deleted", "message_replied"]).optional(),
    message: z.record(z.unknown()).optional(),
    previous_message: z.record(z.unknown()).optional(),
    hidden: z.boolean().optional(),
    deleted_ts: z
      .string()
      .regex(/^\d{10}\.\d{6}$/)
      .optional(),
    edited: z.object({ user: z.string(), ts: z.string() }).optional(),
    reactions: z
      .array(
        z.object({
          name: z.string(),
          users: z.array(z.string()),
          count: z.number().int().nonnegative(),
        }),
      )
      .optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.subtype === "message_deleted" && (!payload.hidden || !payload.deleted_ts)) {
      ctx.addIssue({
        code: "custom",
        message: "Slack message_deleted events require hidden and deleted_ts",
      });
    }
    if (payload.subtype === "message_changed" && (!payload.message || !payload.previous_message)) {
      ctx.addIssue({
        code: "custom",
        message: "Slack message_changed events require message and previous_message",
      });
    }
    if (!payload.user && !payload.bot_id) {
      ctx.addIssue({ code: "custom", message: "Slack message events require user or bot_id" });
    }
  });

const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() }).strict();
const gmailMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    labelIds: z.array(z.string().min(1)),
    snippet: z.string(),
    historyId: z.string(),
    internalDate: z.string().regex(/^\d+$/),
    sizeEstimate: z.number().int().positive(),
    payload: z
      .object({
        partId: z.string(),
        mimeType: z.string(),
        filename: z.string(),
        headers: z.array(gmailHeaderSchema),
        body: z.object({ size: z.number().int().nonnegative() }).strict(),
      })
      .strict(),
  })
  .strict();
const gmailThreadSchema = z
  .object({
    id: z.string().min(1),
    historyId: z.string(),
    messages: z.array(gmailMessageSchema).min(1),
  })
  .strict();

const calendarDateTimeSchema = z
  .object({
    dateTime: isoDateTime,
    timeZone: z.string(),
  })
  .strict();
const calendarEventSchema = z
  .object({
    kind: z.literal("calendar#event"),
    etag: z.string(),
    id: z.string().min(1),
    htmlLink: urlString,
    status: z.enum(["confirmed", "tentative", "cancelled"]),
    summary: z.string(),
    description: z.string().optional(),
    organizer: z
      .object({ email: z.string().email(), displayName: z.string(), self: z.boolean().optional() })
      .strict(),
    creator: z.object({ email: z.string().email(), displayName: z.string() }).strict(),
    attendees: z
      .array(
        z
          .object({
            email: z.string().email(),
            displayName: z.string(),
            responseStatus: z.enum(["needsAction", "declined", "tentative", "accepted"]),
          })
          .strict(),
      )
      .optional(),
    start: calendarDateTimeSchema,
    end: calendarDateTimeSchema,
    recurringEventId: z.string().optional(),
    recurrence: z.array(z.string()).optional(),
    created: isoDateTime,
    updated: isoDateTime,
  })
  .strict();

const notionUserSchema = z.object({ object: z.literal("user"), id: z.string().uuid() }).strict();
const notionTextPropertySchema = z
  .object({
    id: z.string(),
    type: z.literal("title"),
    title: z.array(
      z
        .object({
          type: z.literal("text"),
          text: z.object({ content: z.string() }).strict(),
          plain_text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
const notionStatusPropertySchema = z
  .object({
    id: z.string(),
    type: z.literal("status"),
    status: z.object({ name: z.string(), color: z.string() }).strict(),
  })
  .strict();
const notionRichTextPropertySchema = z
  .object({
    id: z.string(),
    type: z.literal("rich_text"),
    rich_text: z.array(
      z
        .object({
          type: z.literal("text"),
          text: z.object({ content: z.string() }).strict(),
          plain_text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
const notionPageSchema = z
  .object({
    object: z.literal("page"),
    id: z.string().uuid(),
    created_time: isoDateTime,
    last_edited_time: isoDateTime,
    created_by: notionUserSchema,
    last_edited_by: notionUserSchema,
    archived: z.boolean(),
    in_trash: z.boolean(),
    url: urlString,
    parent: z.union([
      z.object({ type: z.literal("database_id"), database_id: z.string().uuid() }).strict(),
      z.object({ type: z.literal("page_id"), page_id: z.string().uuid() }).strict(),
    ]),
    properties: z.record(
      z.union([
        notionTextPropertySchema,
        notionStatusPropertySchema,
        notionRichTextPropertySchema,
        z.record(z.unknown()),
      ]),
    ),
  })
  .strict();

const jiraUserSchema = z
  .object({
    self: urlString,
    accountId: z.string().min(1),
    emailAddress: z.string().email().optional(),
    displayName: z.string(),
    active: z.boolean(),
  })
  .strict();
const jiraIssueSchema = z
  .object({
    expand: z.string().optional(),
    id: z.string().regex(/^\d+$/),
    self: urlString,
    key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
    fields: z
      .object({
        summary: z.string(),
        issuetype: z.object({ id: z.string(), name: z.string() }).strict(),
        project: z.object({ id: z.string(), key: z.string(), name: z.string() }).strict(),
        status: z
          .object({
            name: z.string(),
            statusCategory: z.object({ key: z.string(), name: z.string() }).strict(),
          })
          .strict(),
        priority: z.object({ name: z.string() }).strict(),
        reporter: jiraUserSchema,
        assignee: jiraUserSchema.nullable(),
        created: isoDateTime,
        updated: isoDateTime,
        duedate: dateOnly.nullable().optional(),
        labels: z.array(z.string()).optional(),
        description: z.record(z.unknown()).optional(),
        customfield_10020: z.array(z.object({ name: z.string() }).strict()).optional(),
      })
      .strict(),
    changelog: z
      .object({
        histories: z.array(
          z
            .object({
              id: z.string(),
              created: isoDateTime,
              author: jiraUserSchema,
              items: z.array(
                z
                  .object({
                    field: z.string(),
                    fromString: z.string().nullable(),
                    toString: z.string().nullable(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .optional(),
  })
  .strict();

const productboardRelationshipResourceSchema = z
  .object({
    data: z.union([
      z.object({ type: z.string(), id: z.string() }).strict(),
      z.array(z.object({ type: z.string(), id: z.string() }).strict()),
    ]),
  })
  .strict();
const productboardBaseSchema = z
  .object({
    data: z
      .object({
        type: z.enum(["feature", "note"]),
        id: z.string().min(1),
        attributes: z.record(z.unknown()),
        relationships: z
          .object({
            owner: productboardRelationshipResourceSchema,
            product: productboardRelationshipResourceSchema,
            companies: productboardRelationshipResourceSchema.optional(),
          })
          .strict()
          .optional(),
        links: z.object({ self: urlString }).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const data = payload.data;
    if (data.type === "feature") {
      const parsed = z
        .object({
          name: z.string(),
          description: z.string(),
          status: z.object({ name: z.string() }).strict(),
          created_at: isoDateTime,
          updated_at: isoDateTime,
        })
        .strict()
        .safeParse(data.attributes);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["data", "attributes", ...issue.path],
            message: issue.message,
          });
        }
      }
    } else {
      const parsed = z
        .object({
          title: z.string(),
          content: z.string(),
          note_type: z.literal("textNote"),
          created_at: isoDateTime,
          updated_at: isoDateTime,
        })
        .strict()
        .safeParse(data.attributes);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["data", "attributes", ...issue.path],
            message: issue.message,
          });
        }
      }
    }
  });

const amplitudeChartResponseSchema = z
  .object({
    data: z
      .object({
        series: z.array(z.array(z.number())),
        seriesMeta: z.array(z.record(z.unknown())),
        xValues: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

const githubUserSchema = z
  .object({
    login: z.string(),
    id: z.number().int(),
    node_id: z.string(),
    type: z.string(),
    site_admin: z.boolean(),
    html_url: urlString,
  })
  .strict();
const githubPullRequestSchema = z
  .object({
    id: z.number().int(),
    node_id: z.string(),
    number: z.number().int(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    body: z.string().nullable(),
    user: githubUserSchema,
    html_url: urlString,
    draft: z.boolean(),
    merged: z.boolean(),
    mergeable: z.boolean().nullable(),
    requested_reviewers: z.array(githubUserSchema),
    head: z
      .object({
        ref: z.string(),
        sha: z.string(),
        repo: z.object({ full_name: z.string() }).strict(),
      })
      .strict(),
    base: z
      .object({
        ref: z.string(),
        sha: z.string(),
        repo: z.object({ full_name: z.string() }).strict(),
      })
      .strict(),
    created_at: isoDateTime,
    updated_at: isoDateTime,
    closed_at: isoDateTime.nullable(),
    merged_at: isoDateTime.nullable(),
  })
  .strict();
const githubIssueSchema = z
  .object({
    id: z.number().int(),
    node_id: z.string(),
    number: z.number().int(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    body: z.string().nullable(),
    user: githubUserSchema,
    labels: z.array(
      z.object({ id: z.number().int(), name: z.string(), color: z.string() }).strict(),
    ),
    assignees: z.array(githubUserSchema),
    comments: z.number().int().nonnegative(),
    html_url: urlString,
    created_at: isoDateTime,
    updated_at: isoDateTime,
    closed_at: isoDateTime.nullable(),
  })
  .strict();
const githubCommitSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    node_id: z.string(),
    url: urlString,
    html_url: urlString,
    comments_url: urlString,
    commit: z
      .object({
        author: z
          .object({ name: z.string(), email: z.string().email(), date: isoDateTime })
          .strict(),
        committer: z
          .object({ name: z.string(), email: z.string().email(), date: isoDateTime })
          .strict(),
        message: z.string(),
        tree: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), url: urlString }).strict(),
        url: urlString,
        comment_count: z.number().int().nonnegative(),
        verification: z
          .object({
            verified: z.boolean(),
            reason: z.string(),
            signature: z.string().nullable(),
            payload: z.string().nullable(),
          })
          .strict(),
      })
      .strict(),
    author: githubUserSchema.nullable(),
    committer: githubUserSchema.nullable(),
    parents: z.array(
      z
        .object({
          sha: z.string().regex(/^[a-f0-9]{40}$/),
          url: urlString,
          html_url: urlString,
        })
        .strict(),
    ),
    stats: z
      .object({
        total: z.number().int().nonnegative(),
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            sha: z.string().regex(/^[a-f0-9]{40}$/),
            filename: z.string(),
            status: z.enum(["added", "removed", "modified", "renamed"]),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
            changes: z.number().int().nonnegative(),
            blob_url: urlString,
            raw_url: urlString,
            contents_url: urlString,
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const githubReleaseSchema = z
  .object({
    id: z.number().int(),
    node_id: z.string(),
    tag_name: z.string(),
    target_commitish: z.string(),
    name: z.string().nullable(),
    body: z.string().nullable(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    created_at: isoDateTime,
    published_at: isoDateTime.nullable(),
    author: githubUserSchema,
    html_url: urlString,
    url: urlString,
    assets_url: urlString,
    upload_url: z.string().url().or(z.string().includes("{?name,label}")),
    tarball_url: urlString.nullable(),
    zipball_url: urlString.nullable(),
    assets: z.array(z.record(z.unknown())),
  })
  .strict();

const pagerDutyReferenceSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    summary: z.string(),
    self: urlString,
    html_url: urlString.optional(),
  })
  .strict();
const pagerDutyIncidentSchema = z
  .object({
    id: z.string(),
    type: z.literal("incident"),
    summary: z.string(),
    title: z.string(),
    incident_number: z.number().int().positive(),
    status: z.enum(["triggered", "acknowledged", "resolved"]),
    urgency: z.enum(["high", "low"]),
    html_url: urlString,
    created_at: isoDateTime,
    updated_at: isoDateTime,
    service: pagerDutyReferenceSchema,
    assignments: z.array(
      z.object({ at: isoDateTime, assignee: pagerDutyReferenceSchema }).strict(),
    ),
    acknowledgements: z.array(
      z.object({ at: isoDateTime, acknowledger: pagerDutyReferenceSchema }).strict(),
    ),
    escalation_policy: pagerDutyReferenceSchema,
    pending_actions: z.array(z.object({ type: z.string(), at: isoDateTime }).strict()).optional(),
  })
  .strict();

const salesforceAttributesSchema = z
  .object({
    type: z.string(),
    url: z.string().regex(/^\/services\/data\/v\d+\.\d+\/sobjects\/[A-Za-z]+\/[A-Za-z0-9]{15,18}$/),
  })
  .strict();
const salesforceAccountSchema = z
  .object({
    attributes: salesforceAttributesSchema.extend({ type: z.literal("Account") }),
    Id: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Name: z.string(),
    OwnerId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Type: z.string().nullable().optional(),
    Industry: z.string().nullable().optional(),
    BillingCountry: z.string().nullable().optional(),
    LastModifiedDate: isoDateTime,
  })
  .strict();
const salesforceContactSchema = z
  .object({
    attributes: salesforceAttributesSchema.extend({ type: z.literal("Contact") }),
    Id: z.string().regex(/^[A-Za-z0-9]{18}$/),
    AccountId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    OwnerId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    FirstName: z.string().nullable().optional(),
    LastName: z.string(),
    Email: z.string().email().nullable().optional(),
    Title: z.string().nullable().optional(),
    LastModifiedDate: isoDateTime,
  })
  .strict();
const salesforceOpportunitySchema = z
  .object({
    attributes: salesforceAttributesSchema.extend({ type: z.literal("Opportunity") }),
    Id: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Name: z.string(),
    AccountId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    OwnerId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Amount: z.number().nullable(),
    StageName: z.string(),
    CloseDate: dateOnly.nullable(),
    NextStep: z.string().nullable().optional(),
    LastModifiedDate: isoDateTime,
    Simulator_Risk_State__c: z.string().nullable().optional(),
    Simulator_Procurement_Delay__c: z.boolean().optional(),
  })
  .strict();
const salesforceTaskSchema = z
  .object({
    attributes: salesforceAttributesSchema.extend({ type: z.literal("Task") }),
    Id: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Subject: z.string(),
    Status: z.enum(["Not Started", "In Progress", "Completed", "Deferred"]),
    ActivityDate: dateOnly.nullable(),
    OwnerId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    WhatId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Description: z.string().nullable(),
    LastModifiedDate: isoDateTime,
  })
  .strict();
const salesforceEventSchema = z
  .object({
    attributes: salesforceAttributesSchema.extend({ type: z.literal("Event") }),
    Id: z.string().regex(/^[A-Za-z0-9]{18}$/),
    Subject: z.string(),
    OwnerId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    WhoId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    WhatId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    AccountId: z.string().regex(/^[A-Za-z0-9]{18}$/),
    StartDateTime: isoDateTime,
    EndDateTime: isoDateTime,
    Description: z.string().nullable(),
    LastModifiedDate: isoDateTime,
  })
  .strict();

const gainsightBaseSchema = z
  .object({
    objectName: z.enum(["CallToAction", "SuccessPlan", "ScorecardMeasure", "TimelineActivity"]),
    GSID: z.string().uuid(),
    Name: z.string().optional(),
    CompanyId: z.string().uuid(),
    OwnerId: z.string().uuid().optional(),
    Status: z.string().optional(),
    Score: z.number().optional(),
    Trend: z.string().optional(),
    Type: z.string().optional(),
    ActivityDate: dateOnly.optional(),
    Body: z.string().optional(),
    DueDate: dateOnly.optional(),
    LastModifiedDate: isoDateTime,
    CustomFields: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.objectName !== "ScorecardMeasure" && !payload.OwnerId) {
      ctx.addIssue({ code: "custom", message: "Gainsight non-scorecard objects require OwnerId" });
    }
    if (payload.objectName === "ScorecardMeasure" && typeof payload.Score !== "number") {
      ctx.addIssue({ code: "custom", message: "Gainsight ScorecardMeasure requires Score" });
    }
    if (
      payload.objectName === "TimelineActivity" &&
      (!payload.Type || !payload.ActivityDate || !payload.Body)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Gainsight TimelineActivity requires Type, ActivityDate, and Body",
      });
    }
  });

const zendeskTicketSchema = z
  .object({
    id: z.number().int().positive(),
    url: urlString,
    external_id: z.string().nullable(),
    subject: z.string(),
    raw_subject: z.string(),
    description: z.string().nullable(),
    status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]),
    priority: z.enum(["urgent", "high", "normal", "low"]).nullable(),
    type: z.enum(["problem", "incident", "question", "task"]).nullable(),
    requester_id: z.number().int().positive(),
    submitter_id: z.number().int().positive(),
    assignee_id: z.number().int().positive().nullable(),
    organization_id: z.number().int().positive().nullable(),
    group_id: z.number().int().positive().nullable(),
    tags: z.array(z.string()),
    custom_fields: z.array(z.object({ id: z.number().int(), value: z.unknown() }).strict()),
    created_at: isoDateTime,
    updated_at: isoDateTime,
    comment: z
      .object({
        body: z.string(),
        public: z.boolean(),
        author_id: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const vendorPayloadSchemas: Record<SourceSystem, Record<string, z.ZodTypeAny>> = {
  slack: { message: slackMessageSchema },
  gmail: { message: gmailMessageSchema, thread: gmailThreadSchema },
  calendar: { event: calendarEventSchema, meeting: calendarEventSchema },
  notion: {
    page: notionPageSchema,
    decision_log: notionPageSchema,
    database_item: notionPageSchema,
  },
  jira: {
    issue: jiraIssueSchema,
    epic: jiraIssueSchema,
    story: jiraIssueSchema,
    task: jiraIssueSchema,
    bug: jiraIssueSchema,
  },
  productboard: {
    feature: productboardBaseSchema,
    note: productboardBaseSchema,
    insight: productboardBaseSchema,
  },
  amplitude: {
    chart_response: amplitudeChartResponseSchema,
    metric_snapshot: amplitudeChartResponseSchema,
    funnel: amplitudeChartResponseSchema,
    cohort: amplitudeChartResponseSchema,
  },
  github: {
    pull_request: githubPullRequestSchema,
    issue: githubIssueSchema,
    commit: githubCommitSchema,
    release: githubReleaseSchema,
  },
  pagerduty: { incident: pagerDutyIncidentSchema },
  salesforce: {
    Account: salesforceAccountSchema,
    account: salesforceAccountSchema,
    Contact: salesforceContactSchema,
    contact: salesforceContactSchema,
    Opportunity: salesforceOpportunitySchema,
    opportunity: salesforceOpportunitySchema,
    opportunity_update: salesforceOpportunitySchema,
    Task: salesforceTaskSchema,
    task: salesforceTaskSchema,
    activity: salesforceTaskSchema,
    Event: salesforceEventSchema,
    event: salesforceEventSchema,
  },
  gainsight: {
    CallToAction: gainsightBaseSchema,
    cta: gainsightBaseSchema,
    SuccessPlan: gainsightBaseSchema,
    success_plan: gainsightBaseSchema,
    ScorecardMeasure: gainsightBaseSchema,
    health_score: gainsightBaseSchema,
    milestone: gainsightBaseSchema,
    TimelineActivity: gainsightBaseSchema,
  },
  zendesk: { ticket: zendeskTicketSchema },
};

export const canonicalVendorPayloadFamilies: Record<SourceSystem, string[]> = {
  slack: ["message"],
  gmail: ["message", "thread"],
  calendar: ["event"],
  notion: ["page"],
  jira: ["issue"],
  productboard: ["feature", "note"],
  amplitude: ["chart_response"],
  github: ["commit", "issue", "pull_request", "release"],
  pagerduty: ["incident"],
  salesforce: ["Account", "Contact", "Event", "Opportunity", "Task"],
  gainsight: ["CallToAction", "ScorecardMeasure", "SuccessPlan", "TimelineActivity"],
  zendesk: ["ticket"],
};

export function canonicalPayloadFamily(sourceSystem: SourceSystem, objectType: string): string {
  if (sourceSystem === "slack") return "message";
  if (sourceSystem === "gmail") return objectType === "thread" ? "thread" : "message";
  if (sourceSystem === "calendar") return "event";
  if (sourceSystem === "notion") return "page";
  if (sourceSystem === "jira") return "issue";
  if (sourceSystem === "productboard") return objectType === "insight" ? "note" : objectType;
  if (sourceSystem === "amplitude") return "chart_response";
  if (sourceSystem === "salesforce") {
    if (["Account", "Contact", "Event", "Opportunity", "Task"].includes(objectType))
      return objectType;
    if (objectType === "account") return "Account";
    if (objectType === "contact") return "Contact";
    if (objectType === "event") return "Event";
    if (objectType === "task" || objectType === "activity") return "Task";
    return "Opportunity";
  }
  if (sourceSystem === "gainsight") {
    if (objectType === "cta") return "CallToAction";
    if (objectType === "success_plan") return "SuccessPlan";
    if (objectType === "health_score") return "ScorecardMeasure";
    if (objectType === "milestone") return "TimelineActivity";
  }
  return objectType;
}

export function validateVendorPayload(
  sourceSystem: SourceSystem,
  objectType: string | undefined,
  payload: unknown,
): ValidationResult {
  const metadataValidation = assertNoSimulatorMetadata(payload);
  const errors = [...metadataValidation.errors];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    errors.push(`${sourceSystem} payload must be an object`);
    return { ok: false, errors };
  }
  const family = canonicalPayloadFamily(
    sourceSystem,
    objectType ?? inferPayloadFamily(sourceSystem, payload),
  );
  const schema = vendorPayloadSchemas[sourceSystem][family];
  if (!schema) {
    errors.push(`${sourceSystem} does not support rawPayload family ${family}`);
    return { ok: false, errors };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    errors.push(
      ...parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "rawPayload"}: ${issue.message}`,
      ),
    );
  }
  errors.push(...familyDiscriminatorErrors(sourceSystem, family, payload));
  return { ok: errors.length === 0, errors };
}

function familyDiscriminatorErrors(
  sourceSystem: SourceSystem,
  family: string,
  payload: unknown,
): string[] {
  const candidate = payload as Record<string, unknown>;
  if (sourceSystem === "productboard") {
    const data = candidate.data as Record<string, unknown> | undefined;
    if (data?.type !== family) return [`productboard payload data.type must be ${family}`];
  }
  if (sourceSystem === "salesforce") {
    const attributes = candidate.attributes as Record<string, unknown> | undefined;
    if (attributes?.type !== family) return [`salesforce attributes.type must be ${family}`];
  }
  if (sourceSystem === "gainsight" && candidate.objectName !== family) {
    return [`gainsight objectName must be ${family}`];
  }
  return [];
}

function inferPayloadFamily(sourceSystem: SourceSystem, payload: unknown): string {
  const candidate = payload as Record<string, unknown>;
  if (sourceSystem === "gmail" && Array.isArray(candidate.messages)) return "thread";
  if (
    sourceSystem === "salesforce" &&
    typeof candidate.attributes === "object" &&
    candidate.attributes !== null
  ) {
    const attributes = candidate.attributes as Record<string, unknown>;
    if (typeof attributes.type === "string") return attributes.type;
  }
  if (sourceSystem === "gainsight" && typeof candidate.objectName === "string")
    return candidate.objectName;
  if (
    sourceSystem === "productboard" &&
    typeof candidate.data === "object" &&
    candidate.data !== null
  ) {
    const data = candidate.data as Record<string, unknown>;
    if (typeof data.type === "string") return data.type;
  }
  if (sourceSystem === "amplitude" && typeof candidate.data === "object") return "chart_response";
  if (sourceSystem === "github" && typeof candidate.head === "object") return "pull_request";
  if (sourceSystem === "github" && typeof candidate.commit === "object") return "commit";
  if (sourceSystem === "github" && "tag_name" in candidate) return "release";
  if (sourceSystem === "github") return "issue";
  if (sourceSystem === "calendar") return "event";
  if (sourceSystem === "notion") return "page";
  if (sourceSystem === "jira") return "issue";
  if (sourceSystem === "slack") return "message";
  if (sourceSystem === "pagerduty") return "incident";
  if (sourceSystem === "zendesk") return "ticket";
  return "unknown";
}
