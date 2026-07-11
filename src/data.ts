import type { ScenarioDefinition, Tenant } from "./domain.js";

export const tenant: Tenant = {
  id: "tenant-acme-digital-ops",
  name: "Acme Digital Operations",
  slug: "acme-digital-ops",
};

const groupAcl = (groups: string[]) => ({ visibility: "group" as const, groups, users: [] });

export const scenarios: ScenarioDefinition[] = [
  {
    id: "product-launch-readiness",
    title: "Product launch readiness",
    department: "product",
    description: "Launch target pressure with incomplete requirements, customer commitments, engineering dependency, and roadmap risk.",
    participantRoleTemplateIds: ["role-product-ic", "role-product-manager", "role-product-director", "role-product-vp"],
    sourceSystems: ["slack", "gmail", "notion", "jira", "productboard", "amplitude"],
    events: [
      {
        id: "baseline",
        label: "Launch room opens",
        atHour: 0,
        records: [
          { id: "launch-slack-thread", sourceSystem: "slack", objectType: "message", title: "Launch readiness thread", actorRoleTemplateId: "role-product-manager", acl: groupAcl(["product-launch-team"]), rawPayload: { channel: "#launch-readiness", threadTs: "1000.000", text: "Launch readiness review is open; dependency details are still moving." } },
          { id: "launch-notion-brief", sourceSystem: "notion", objectType: "page", title: "Q3 workflow launch brief", actorRoleTemplateId: "role-product-ic", assignmentRoleTemplateId: "role-product-manager", acl: groupAcl(["product-launch-team"]), rawPayload: { pageId: "notion-launch-brief", status: "Draft", lastEditedByRole: "product_ic" } },
        ],
      },
      {
        id: "customer-commitment",
        label: "Customer commitment appears",
        atHour: 8,
        records: [
          { id: "launch-gmail-commitment", sourceSystem: "gmail", objectType: "email", title: "Enterprise preview commitment", actorRoleTemplateId: "role-product-manager", acl: groupAcl(["product-managers", "product-leadership", "exec-staff"]), rawPayload: { threadId: "gmail-launch-commitment", subject: "Preview timeline for Northstar", labels: ["customers", "launch"] } },
          { id: "launch-productboard-insight", sourceSystem: "productboard", objectType: "insight", title: "Preview customer expects workflow export", actorRoleTemplateId: "role-product-manager", assignmentRoleTemplateId: "role-product-ic", acl: groupAcl(["product-launch-team", "product-managers"]), rawPayload: { featureId: "pb-feature-workflow-export", insightType: "commitment", status: "linked" } },
        ],
      },
      {
        id: "dependency-risk",
        label: "Engineering dependency slips",
        atHour: 24,
        records: [
          { id: "launch-jira-dependency", sourceSystem: "jira", objectType: "issue", title: "Workflow export API dependency", actorRoleTemplateId: "role-engineering-manager", assignmentRoleTemplateId: "role-engineering-ic", acl: groupAcl(["product-launch-team", "engineering-platform"]), rawPayload: { key: "PROD-214", status: "Blocked", priority: "High", dependency: "export-api" }, updatedAfterHours: 6 },
          { id: "launch-amplitude-adoption", sourceSystem: "amplitude", objectType: "metric_snapshot", title: "Beta workflow adoption dipped", actorRoleTemplateId: "role-product-ic", acl: groupAcl(["product-launch-team"]), rawPayload: { chartId: "amp-workflow-beta", sevenDayChangePct: -18, cohort: "beta" } },
        ],
      },
      {
        id: "exec-pressure",
        label: "Executive pressure lands",
        atHour: 36,
        records: [
          { id: "launch-exec-email", sourceSystem: "gmail", objectType: "email", title: "Launch date question for staff", actorRoleTemplateId: "role-product-vp", acl: groupAcl(["exec-staff"]), rawPayload: { threadId: "gmail-exec-launch", subject: "Friday staff launch readout", sensitivity: "executive" } },
        ],
      },
    ],
  },
  {
    id: "reliability-incident",
    title: "Reliability incident",
    department: "engineering",
    description: "Service degradation with incident response, GitHub fix, customer escalation, and postmortem.",
    participantRoleTemplateIds: ["role-engineering-ic", "role-engineering-manager", "role-engineering-director", "role-engineering-vp"],
    sourceSystems: ["pagerduty", "slack", "github", "jira", "calendar", "notion", "gmail"],
    events: [
      { id: "incident-opened", label: "Incident opens", atHour: 0, records: [
        { id: "incident-pagerduty", sourceSystem: "pagerduty", objectType: "incident", title: "Ingestion latency degradation", actorRoleTemplateId: "role-engineering-ic", assignmentRoleTemplateId: "role-engineering-manager", acl: groupAcl(["incident-response", "engineering-platform"]), rawPayload: { incidentId: "PD-8842", severity: "sev2", status: "triggered" }, updatedAfterHours: 4 },
        { id: "incident-slack-channel", sourceSystem: "slack", objectType: "message", title: "SEV2 incident channel opened", actorRoleTemplateId: "role-engineering-manager", acl: groupAcl(["incident-response"]), rawPayload: { channel: "#inc-ingestion-latency", text: "SEV2 declared. First look points at queue saturation." } },
      ] },
      { id: "fix-in-flight", label: "Fix work starts", atHour: 5, records: [
        { id: "incident-github-pr", sourceSystem: "github", objectType: "pull_request", title: "Throttle connector retries under queue pressure", actorRoleTemplateId: "role-engineering-ic", assignmentRoleTemplateId: "role-engineering-ic", acl: groupAcl(["engineering-platform", "incident-response"]), rawPayload: { repo: "acme/connector-gateway", pr: 418, checks: "pending", reviewState: "changes_requested" }, updatedAfterHours: 3 },
        { id: "incident-jira", sourceSystem: "jira", objectType: "issue", title: "Backfill retry controls for connector queue", actorRoleTemplateId: "role-engineering-manager", assignmentRoleTemplateId: "role-engineering-ic", acl: groupAcl(["engineering-platform", "engineering-managers"]), rawPayload: { key: "ENG-1842", status: "In Progress", priority: "High" } },
      ] },
      { id: "postmortem-scheduled", label: "Postmortem scheduled", atHour: 22, records: [
        { id: "incident-calendar-postmortem", sourceSystem: "calendar", objectType: "meeting", title: "Ingestion latency postmortem", actorRoleTemplateId: "role-engineering-manager", acl: groupAcl(["incident-response", "engineering-leadership"]), rawPayload: { eventId: "cal-postmortem-8842", attendeeRoles: ["engineering", "customer_success"], status: "confirmed" } },
        { id: "incident-notion-postmortem", sourceSystem: "notion", objectType: "page", title: "PD-8842 postmortem draft", actorRoleTemplateId: "role-engineering-manager", assignmentRoleTemplateId: "role-engineering-director", acl: groupAcl(["engineering-leadership"]), rawPayload: { pageId: "notion-pd-8842", status: "Draft", openQuestions: 3 } },
      ] },
      { id: "exec-incident-summary", label: "VP incident summary", atHour: 30, records: [
        { id: "incident-vp-summary", sourceSystem: "gmail", objectType: "email", title: "Executive incident summary", actorRoleTemplateId: "role-engineering-vp", acl: groupAcl(["exec-staff"]), rawPayload: { threadId: "gmail-incident-exec", subject: "SEV2 customer impact and remediation" } },
      ] },
    ],
  },
  {
    id: "renewal-risk",
    title: "Renewal risk",
    department: "customer_success",
    description: "Sponsor silence, support volume, weak adoption, and commercial renewal pressure converge.",
    participantRoleTemplateIds: ["role-customer-success-ic", "role-customer-success-manager", "role-customer-success-director", "role-customer-success-vp"],
    sourceSystems: ["salesforce", "gmail", "zendesk", "gainsight", "slack", "calendar"],
    events: [
      { id: "baseline", label: "Renewal workspace active", atHour: 0, records: [
        { id: "renewal-salesforce-oppty", sourceSystem: "salesforce", objectType: "opportunity", title: "Northstar Medical renewal", actorRoleTemplateId: "role-customer-success-ic", assignmentRoleTemplateId: "role-customer-success-manager", acl: groupAcl(["account-northstar", "cs-east"]), rawPayload: { account: "Northstar Medical", stage: "Renewal", amount: 245000, closeDate: "2026-08-15" } },
        { id: "renewal-gainsight-health", sourceSystem: "gainsight", objectType: "health_score", title: "Northstar health score", actorRoleTemplateId: "role-customer-success-ic", acl: groupAcl(["account-northstar", "cs-east"]), rawPayload: { account: "Northstar Medical", score: 63, trend: "down" }, updatedAfterHours: 12 },
      ] },
      { id: "support-escalation", label: "Support escalation grows", atHour: 12, records: [
        { id: "renewal-zendesk-ticket", sourceSystem: "zendesk", objectType: "ticket", title: "Northstar export failure escalation", actorRoleTemplateId: "role-customer-success-ic", assignmentRoleTemplateId: "role-engineering-ic", acl: groupAcl(["account-northstar", "cs-east"]), rawPayload: { ticketId: "ZD-9917", severity: "high", status: "open", escalation: true } },
        { id: "renewal-slack-escalation", sourceSystem: "slack", objectType: "message", title: "Northstar renewal risk thread", actorRoleTemplateId: "role-customer-success-manager", acl: groupAcl(["cs-managers", "account-northstar"]), rawPayload: { channel: "#cs-renewals", text: "Support escalation is now tied to renewal confidence." } },
      ] },
      { id: "sponsor-silent", label: "Sponsor goes quiet", atHour: 28, records: [
        { id: "renewal-gmail-sponsor", sourceSystem: "gmail", objectType: "email", title: "Northstar sponsor follow-up", actorRoleTemplateId: "role-customer-success-ic", acl: groupAcl(["account-northstar", "cs-east"]), rawPayload: { threadId: "gmail-northstar-followup", subject: "Checking in on renewal next steps", replyStatus: "no_response" } },
        { id: "renewal-calendar-qbr", sourceSystem: "calendar", objectType: "meeting", title: "Northstar QBR rescheduled", actorRoleTemplateId: "role-customer-success-manager", acl: groupAcl(["account-northstar", "cs-managers"]), rawPayload: { eventId: "cal-northstar-qbr", status: "rescheduled", previousTime: "2026-07-12T18:00:00.000Z" } },
      ] },
      { id: "vp-risk", label: "VP renewal risk review", atHour: 42, records: [
        { id: "renewal-vp-brief", sourceSystem: "salesforce", objectType: "opportunity_update", title: "Northstar marked at risk", actorRoleTemplateId: "role-customer-success-vp", acl: groupAcl(["cs-leadership", "exec-staff"]), rawPayload: { account: "Northstar Medical", stage: "Renewal Risk", nextStep: "Executive sponsor outreach" } },
      ] },
    ],
  },
];

export const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
