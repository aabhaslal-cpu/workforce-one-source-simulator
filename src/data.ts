import type { Acl, ScenarioDefinition, ScenarioRecordTemplate, SourceSystem } from "./domain.js";

export const tenant = {
  id: "tenant-acme-digital-ops",
  name: "Acme Digital Operations",
  slug: "acme-digital-ops",
};

const groupAcl = (groups: string[], visibility: Acl["visibility"] = "group"): Acl => ({
  visibility,
  groups,
  users: [],
});

function record(
  id: string,
  sourceSystem: SourceSystem,
  objectType: string,
  title: string,
  actorRoleTemplateId: string,
  groups: string[],
  rawPayload: Record<string, unknown>,
  options: Partial<
    Omit<
      ScenarioRecordTemplate,
      "id" | "sourceSystem" | "objectType" | "title" | "actorRoleTemplateId" | "acl" | "rawPayload"
    >
  > = {},
): ScenarioRecordTemplate {
  return {
    id,
    sourceSystem,
    objectType,
    title,
    actorRoleTemplateId,
    acl: groupAcl(groups, rawPayload.restricted === true ? "restricted" : "group"),
    rawPayload,
    ...options,
  };
}

const sourcePreferredForScenario = (
  scenarioSourceSystems: SourceSystem[],
  preferred: SourceSystem[],
): SourceSystem => {
  const available = preferred.find((sourceSystem) => scenarioSourceSystems.includes(sourceSystem));
  return available ?? scenarioSourceSystems[0] ?? "gmail";
};

const roleWorkArtifact = (
  scenarioSourceSystems: SourceSystem[],
  roleTemplateId: string,
): ScenarioRecordTemplate => {
  const id = `role-work-${roleTemplateId.replace(/^role-/, "")}`;
  const options = {
    assignmentRoleTemplateId: roleTemplateId,
    aclUserRoleTemplateIds: [roleTemplateId],
  };

  switch (roleTemplateId) {
    case "role-product-ic": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "productboard",
        "jira",
        "notion",
        "gmail",
      ]);
      if (sourceSystem === "jira") {
        return record(
          id,
          "jira",
          "task",
          "Customer ask triage for release notes",
          roleTemplateId,
          [],
          {
            projectKey: "PROD",
            issueKey: "PROD-1412",
            priority: "Medium",
            status: "Open",
            summary:
              "Turn customer asks into release-note acceptance criteria and identify which follow-up needs the PM.",
          },
          options,
        );
      }
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Customer ask triage notes",
          roleTemplateId,
          [],
          {
            database: "Product Discovery",
            status: "Draft",
            summary:
              "Notes summarize customer asks, release-note gaps, and open PM follow-up questions.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Customer ask triage follow-up",
          roleTemplateId,
          [],
          {
            subject: "Customer asks to triage before release notes",
            labels: ["workforce-one"],
            summary:
              "Please triage the customer asks and flag which ones need PM review before the release note is finalized.",
          },
          options,
        );
      }
      return record(
        id,
        "productboard",
        "note",
        "Customer ask triage for release notes",
        roleTemplateId,
        [],
        {
          productArea: "Workflow Hub",
          status: "new",
          priorityNote:
            "Customer asks need triage before the release note locks; details should be linked back to the PM.",
        },
        options,
      );
    }
    case "role-product-manager": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gmail",
        "productboard",
        "jira",
        "notion",
      ]);
      if (sourceSystem === "productboard") {
        return record(
          id,
          "productboard",
          "note",
          "Release readiness customer signal",
          roleTemplateId,
          [],
          {
            productArea: "Launch Readiness",
            status: "new",
            priorityNote:
              "Customer-facing readiness gaps are collected for PM decision; supporting details are in Launch readiness tracker.xlsx.",
          },
          options,
        );
      }
      if (sourceSystem === "jira") {
        return record(
          id,
          "jira",
          "task",
          "Review release readiness workbook",
          roleTemplateId,
          [],
          {
            projectKey: "PROD",
            issueKey: "PROD-2205",
            priority: "High",
            status: "Open",
            summary:
              "Review launch readiness tracker.xlsx and decide which gaps block the customer-facing release.",
          },
          options,
        );
      }
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Release readiness workbook review",
          roleTemplateId,
          [],
          {
            database: "Launch Planning",
            status: "Needs review",
            summary:
              "PM notes reference Launch readiness tracker.xlsx and customer-facing release gaps.",
          },
          options,
        );
      }
      return record(
        id,
        "gmail",
        "email",
        "Release readiness gaps before customer note",
        roleTemplateId,
        [],
        {
          subject: "Release readiness gaps before customer note",
          labels: ["workforce-one", "release"],
          summary:
            "Please review the release readiness gaps before the customer note goes out. Details are in Launch readiness tracker.xlsx.",
        },
        options,
      );
    }
    case "role-product-director": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "calendar",
        "notion",
        "gmail",
        "slack",
      ]);
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Product launch tradeoff memo",
          roleTemplateId,
          [],
          {
            database: "Decision Memos",
            status: "Review",
            summary:
              "Director memo frames customer promise, adoption evidence, and engineering readiness tradeoffs.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Product launch tradeoff review",
          roleTemplateId,
          [],
          {
            subject: "Tradeoff review before launch leadership sync",
            labels: ["workforce-one", "leadership"],
            summary:
              "Please review the launch tradeoff memo and decide what needs escalation before leadership sync.",
          },
          options,
        );
      }
      if (sourceSystem === "slack") {
        return record(
          id,
          "slack",
          "thread",
          "Product launch tradeoff review",
          roleTemplateId,
          [],
          {
            channel: "#product-leadership",
            summary:
              "Director-level thread compares customer promise, adoption signal, and readiness risk before launch sync.",
          },
          options,
        );
      }
      return record(
        id,
        "calendar",
        "meeting",
        "Product launch tradeoff review",
        roleTemplateId,
        [],
        {
          agenda:
            "Customer promise, adoption signal, engineering readiness, and launch decision tradeoffs",
          status: "confirmed",
          summary:
            "Director reviews launch tradeoffs and decides what should be escalated before leadership sync.",
        },
        options,
      );
    }
    case "role-product-vp": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gmail",
        "calendar",
        "notion",
        "slack",
      ]);
      if (sourceSystem === "calendar") {
        return record(
          id,
          "calendar",
          "meeting",
          "Executive product launch readout",
          roleTemplateId,
          [],
          {
            agenda:
              "Decision needed on release confidence, customer exposure, and executive messaging",
            status: "confirmed",
            summary:
              "VP Product reviews release confidence and executive messaging before customer-facing commitments are made.",
          },
          options,
        );
      }
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Executive product launch readout",
          roleTemplateId,
          [],
          {
            database: "Exec Readouts",
            status: "Ready",
            summary:
              "Executive readout summarizes release confidence, customer exposure, and launch messaging risks.",
          },
          options,
        );
      }
      if (sourceSystem === "slack") {
        return record(
          id,
          "slack",
          "thread",
          "Executive product launch readout",
          roleTemplateId,
          [],
          {
            channel: "#exec-product",
            summary:
              "VP Product asks for a concise release confidence call before customer-facing commitments are confirmed.",
          },
          options,
        );
      }
      return record(
        id,
        "gmail",
        "email",
        "Executive product launch readout needed",
        roleTemplateId,
        [],
        {
          subject: "Executive product launch readout needed",
          labels: ["workforce-one", "exec"],
          summary:
            "Please send the concise product launch readout with customer exposure, readiness risk, and the decision needed.",
        },
        options,
      );
    }
    case "role-engineering-ic": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "jira",
        "github",
        "slack",
        "gmail",
      ]);
      if (sourceSystem === "github") {
        return record(
          id,
          "github",
          "issue",
          "Patch readiness checklist gap",
          roleTemplateId,
          [],
          {
            repository: "acme/workflow-service",
            status: "open",
            summary:
              "Engineer owns the readiness checklist gap and needs to link the fix before the launch checkpoint.",
          },
          options,
        );
      }
      if (sourceSystem === "slack") {
        return record(
          id,
          "slack",
          "thread",
          "Readiness checklist gap handoff",
          roleTemplateId,
          [],
          {
            channel: "#eng-launch",
            summary:
              "Engineering IC is asked to close the readiness checklist gap and note the test evidence.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Readiness checklist gap assigned",
          roleTemplateId,
          [],
          {
            subject: "Readiness checklist gap assigned",
            labels: ["workforce-one", "engineering"],
            summary:
              "Please close the launch readiness checklist gap and attach the verification note before handoff.",
          },
          options,
        );
      }
      return record(
        id,
        "jira",
        "task",
        "Fix launch readiness checklist gap",
        roleTemplateId,
        [],
        {
          projectKey: "ENG",
          issueKey: "ENG-4318",
          priority: "High",
          status: "Open",
          summary:
            "Fix the launch readiness checklist gap and link the verification evidence before the release checkpoint.",
        },
        options,
      );
    }
    case "role-engineering-manager": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "slack",
        "jira",
        "gmail",
        "notion",
      ]);
      if (sourceSystem === "jira") {
        return record(
          id,
          "jira",
          "task",
          "Coordinate readiness blockers",
          roleTemplateId,
          [],
          {
            projectKey: "ENG",
            issueKey: "ENG-4430",
            priority: "High",
            status: "In Progress",
            summary:
              "Engineering manager coordinates readiness blockers and points the team to the launch dependency workbook.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Engineering readiness blockers need owner updates",
          roleTemplateId,
          [],
          {
            subject: "Engineering readiness blockers need owner updates",
            labels: ["workforce-one", "engineering"],
            summary:
              "Please collect owner updates on the readiness blockers. Details are in Engineering launch dependencies.xlsx.",
          },
          options,
        );
      }
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Engineering readiness blocker rollup",
          roleTemplateId,
          [],
          {
            database: "Engineering Launch",
            status: "Needs owner updates",
            summary:
              "Manager rollup tracks readiness blockers and links Engineering launch dependencies.xlsx.",
          },
          options,
        );
      }
      return record(
        id,
        "slack",
        "thread",
        "Engineering readiness blockers need owner updates",
        roleTemplateId,
        [],
        {
          channel: "#eng-launch",
          summary:
            "Manager asks owners for launch blocker updates and points everyone to Engineering launch dependencies.xlsx.",
        },
        options,
      );
    }
    case "role-engineering-director": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "notion",
        "calendar",
        "github",
        "gmail",
      ]);
      if (sourceSystem === "calendar") {
        return record(
          id,
          "calendar",
          "meeting",
          "Engineering readiness review",
          roleTemplateId,
          [],
          {
            agenda: "Readiness blockers, dependency owners, launch risk, and escalation path",
            status: "confirmed",
            summary:
              "Director reviews engineering readiness and decides which blockers need executive escalation.",
          },
          options,
        );
      }
      if (sourceSystem === "github") {
        return record(
          id,
          "github",
          "pull_request",
          "Engineering readiness evidence rollup",
          roleTemplateId,
          [],
          {
            repository: "acme/workflow-service",
            status: "open",
            summary:
              "Director reviews readiness evidence and release-blocking changes before the launch checkpoint.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Engineering readiness review needed",
          roleTemplateId,
          [],
          {
            subject: "Engineering readiness review needed",
            labels: ["workforce-one", "engineering"],
            summary:
              "Please review engineering readiness blockers and decide which dependency needs leadership escalation.",
          },
          options,
        );
      }
      return record(
        id,
        "notion",
        "page",
        "Engineering readiness review",
        roleTemplateId,
        [],
        {
          database: "Engineering Reviews",
          status: "Review",
          summary:
            "Director review of launch blockers, dependency owners, and engineering readiness evidence.",
        },
        options,
      );
    }
    case "role-engineering-vp": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gmail",
        "calendar",
        "notion",
        "pagerduty",
      ]);
      if (sourceSystem === "calendar") {
        return record(
          id,
          "calendar",
          "meeting",
          "Engineering launch exception review",
          roleTemplateId,
          [],
          {
            agenda:
              "Exception approval, reliability risk, readiness evidence, and customer exposure",
            status: "confirmed",
            summary:
              "VP Engineering reviews whether launch exception risk is acceptable before executive readout.",
          },
          options,
        );
      }
      if (sourceSystem === "notion") {
        return record(
          id,
          "notion",
          "page",
          "Engineering launch exception decision",
          roleTemplateId,
          [],
          {
            database: "Exec Decisions",
            status: "Decision needed",
            summary:
              "VP Engineering decision note on launch exception, reliability risk, and customer exposure.",
          },
          options,
        );
      }
      if (sourceSystem === "pagerduty") {
        return record(
          id,
          "pagerduty",
          "incident",
          "Launch exception reliability watch",
          roleTemplateId,
          [],
          {
            service: "workflow-service",
            status: "triggered",
            severity: "warning",
            summary:
              "Reliability watch opened for launch exception review before VP Engineering approval.",
          },
          options,
        );
      }
      return record(
        id,
        "gmail",
        "email",
        "Release readiness exception approval",
        roleTemplateId,
        [],
        {
          subject: "Release readiness exception approval",
          labels: ["workforce-one", "exec"],
          summary:
            "Please approve or reject the engineering readiness exception after reviewing reliability risk and customer exposure.",
        },
        options,
      );
    }
    case "role-customer-success-ic": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "salesforce",
        "gainsight",
        "gmail",
        "zendesk",
      ]);
      if (sourceSystem === "gainsight") {
        return record(
          id,
          "gainsight",
          "cta",
          "QBR follow-up owner task",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "Open",
            riskReason:
              "Customer asked for a crisp follow-up from the QBR and confirmation of owner next steps.",
            summary:
              "CS IC owns the QBR follow-up and needs to draft the customer reply with next steps.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Draft QBR follow-up reply",
          roleTemplateId,
          [],
          {
            subject: "Draft QBR follow-up reply",
            labels: ["workforce-one", "customer"],
            summary:
              "Please draft a friendly QBR follow-up reply confirming owners, timing, and the customer questions we took away.",
          },
          options,
        );
      }
      if (sourceSystem === "zendesk") {
        return record(
          id,
          "zendesk",
          "ticket",
          "Customer QBR follow-up request",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "open",
            severity: "normal",
            summary:
              "Customer asks for QBR follow-up owners and timing to be confirmed in writing.",
          },
          options,
        );
      }
      return record(
        id,
        "salesforce",
        "task",
        "Draft QBR follow-up reply",
        roleTemplateId,
        [],
        {
          account: "Northstar Medical",
          status: "Not Started",
          subject: "Draft QBR follow-up reply with owner next steps",
          summary:
            "CS IC should draft a QBR follow-up reply confirming owners, timing, and customer questions.",
        },
        options,
      );
    }
    case "role-customer-success-manager": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gmail",
        "zendesk",
        "gainsight",
        "salesforce",
      ]);
      if (sourceSystem === "zendesk") {
        return record(
          id,
          "zendesk",
          "ticket",
          "Customer escalation needs response owner",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "open",
            severity: "high",
            escalation: true,
            summary:
              "Customer escalation asks for a clear response owner and timing before the next stakeholder meeting.",
          },
          options,
        );
      }
      if (sourceSystem === "gainsight") {
        return record(
          id,
          "gainsight",
          "cta",
          "Customer escalation response owner",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "Open",
            riskReason:
              "Escalation needs response owner and timing before the next customer stakeholder meeting.",
            summary:
              "CS manager owns the escalation response plan and needs to align Product and Engineering inputs.",
          },
          options,
        );
      }
      if (sourceSystem === "salesforce") {
        return record(
          id,
          "salesforce",
          "task",
          "Customer escalation response owner",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "Not Started",
            subject: "Confirm escalation response owner and timing",
            summary:
              "CS manager needs to confirm the escalation response owner and timing before the next customer meeting.",
          },
          options,
        );
      }
      return record(
        id,
        "gmail",
        "email",
        "Customer escalation needs response owner",
        roleTemplateId,
        [],
        {
          subject: "Customer escalation needs response owner",
          labels: ["workforce-one", "customer"],
          summary:
            "Please confirm who owns the escalation response and when we can reply to the customer before the next stakeholder meeting.",
        },
        options,
      );
    }
    case "role-customer-success-director": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gainsight",
        "salesforce",
        "calendar",
        "gmail",
      ]);
      if (sourceSystem === "salesforce") {
        return record(
          id,
          "salesforce",
          "opportunity",
          "Customer risk executive rollup",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            stageName: "Renewal Review",
            amount: 425000,
            closeDate: "2026-09-30",
            summary:
              "CS Director reviews renewal risk and escalation status before executive rollup.",
          },
          options,
        );
      }
      if (sourceSystem === "calendar") {
        return record(
          id,
          "calendar",
          "meeting",
          "Customer risk executive rollup",
          roleTemplateId,
          [],
          {
            agenda: "Escalation owner, renewal exposure, QBR commitments, and leadership ask",
            status: "confirmed",
            summary:
              "CS Director reviews customer risk, escalation ownership, and QBR commitments before leadership readout.",
          },
          options,
        );
      }
      if (sourceSystem === "gmail") {
        return record(
          id,
          "gmail",
          "email",
          "Customer risk executive rollup",
          roleTemplateId,
          [],
          {
            subject: "Customer risk executive rollup",
            labels: ["workforce-one", "customer"],
            summary:
              "Please summarize escalation ownership, renewal exposure, and QBR commitments for the executive rollup.",
          },
          options,
        );
      }
      return record(
        id,
        "gainsight",
        "success_plan",
        "Customer risk executive rollup",
        roleTemplateId,
        [],
        {
          account: "Northstar Medical",
          status: "Open",
          riskReason:
            "Director-level rollup needs escalation ownership, renewal exposure, and QBR commitment status.",
          summary:
            "CS Director prepares the customer risk rollup and flags where leadership needs to intervene.",
        },
        options,
      );
    }
    case "role-customer-success-vp": {
      const sourceSystem = sourcePreferredForScenario(scenarioSourceSystems, [
        "gmail",
        "calendar",
        "gainsight",
        "salesforce",
      ]);
      if (sourceSystem === "calendar") {
        return record(
          id,
          "calendar",
          "meeting",
          "Executive customer risk decision",
          roleTemplateId,
          [],
          {
            agenda:
              "Renewal exposure, escalation posture, customer reply timing, and executive decision",
            status: "confirmed",
            summary:
              "VP CS reviews renewal exposure and escalation response before executive customer decision.",
          },
          options,
        );
      }
      if (sourceSystem === "gainsight") {
        return record(
          id,
          "gainsight",
          "cta",
          "Executive customer risk decision",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            status: "Open",
            riskReason:
              "Executive decision needed on customer escalation posture and renewal exposure.",
            summary:
              "VP CS owns the executive customer risk decision and needs the escalation plan summarized.",
          },
          options,
        );
      }
      if (sourceSystem === "salesforce") {
        return record(
          id,
          "salesforce",
          "opportunity",
          "Executive customer risk decision",
          roleTemplateId,
          [],
          {
            account: "Northstar Medical",
            stageName: "Executive Review",
            amount: 425000,
            closeDate: "2026-09-30",
            summary:
              "VP CS reviews renewal exposure and customer escalation posture before the executive decision.",
          },
          options,
        );
      }
      return record(
        id,
        "gmail",
        "email",
        "Executive customer risk decision",
        roleTemplateId,
        [],
        {
          subject: "Executive customer risk decision",
          labels: ["workforce-one", "exec"],
          summary:
            "Please review renewal exposure, escalation posture, and the customer reply timing before the executive decision.",
        },
        options,
      );
    }
    default:
      return record(
        id,
        sourcePreferredForScenario(scenarioSourceSystems, ["gmail", "slack", "notion"]),
        "email",
        "Role-specific work follow-up",
        roleTemplateId,
        [],
        {
          subject: "Role-specific work follow-up",
          labels: ["workforce-one"],
          summary: "Follow-up work item for the person assigned to this scenario role.",
        },
        options,
      );
  }
};

const roleWorkArtifactsForScenario = (scenario: ScenarioDefinition): ScenarioRecordTemplate[] =>
  scenario.participantRoleTemplateIds.map((roleTemplateId) =>
    roleWorkArtifact(scenario.sourceSystems, roleTemplateId),
  );

const withRoleWorkArtifacts = (scenario: ScenarioDefinition): ScenarioDefinition => ({
  ...scenario,
  events: [
    ...scenario.events,
    {
      id: "role-specific-work-artifacts",
      label: "Role-specific source work artifacts",
      atHour: 1,
      records: roleWorkArtifactsForScenario(scenario),
    },
  ],
});

const baseScenarios: ScenarioDefinition[] = [
  {
    id: "regular-workday",
    title: "Regular workday",
    department: "cross_functional",
    description:
      "A normal operating day with planning, customer follow-up, product discovery, engineering execution, private notes, and leadership rollup.",
    participantRoleTemplateIds: [
      "role-product-ic",
      "role-product-manager",
      "role-product-director",
      "role-product-vp",
      "role-engineering-ic",
      "role-engineering-manager",
      "role-engineering-director",
      "role-engineering-vp",
      "role-customer-success-ic",
      "role-customer-success-manager",
      "role-customer-success-director",
      "role-customer-success-vp",
    ],
    sourceSystems: [
      "slack",
      "gmail",
      "calendar",
      "notion",
      "jira",
      "productboard",
      "amplitude",
      "github",
      "pagerduty",
      "salesforce",
      "gainsight",
      "zendesk",
    ],
    events: [
      {
        id: "morning-operating-rhythm",
        label: "Morning operating rhythm",
        atHour: 0,
        records: [
          record(
            "workday-slack-priorities",
            "slack",
            "thread",
            "Daily operating priorities thread",
            "role-product-manager",
            ["project-aurora", "product-launch-team", "engineering-platform", "cs-managers"],
            {
              channel: "#daily-operating-rhythm",
              summary:
                "Product, Engineering, and CS align on customer follow-up, roadmap questions, and delivery focus for the day.",
              message: "Posting today's operating priorities and the few handoffs that need eyes.",
            },
            { updatedAfterHours: 2 },
          ),
          record(
            "workday-calendar-sync",
            "calendar",
            "meeting",
            "Product Engineering CS daily sync",
            "role-product-director",
            ["project-aurora", "product-leadership", "engineering-leadership", "cs-leadership"],
            {
              agenda: "Customer follow-up, delivery blockers, product decisions, support handoffs",
              status: "confirmed",
            },
          ),
          record(
            "workday-notion-plan",
            "notion",
            "page",
            "Daily operating plan",
            "role-product-manager",
            ["project-aurora", "product-managers", "engineering-managers", "cs-managers"],
            {
              database: "Operating Plans",
              status: "Draft",
              updatedStatus: "Shared",
              summary: "Shared working plan for the day's customer, product, and delivery work.",
            },
            { updatedAfterHours: 7 },
          ),
        ],
      },
      {
        id: "customer-and-product-context",
        label: "Customer and product context",
        atHour: 2,
        records: [
          record(
            "workday-salesforce-followup",
            "salesforce",
            "task",
            "Northstar stakeholder follow-up",
            "role-customer-success-manager",
            ["account-northstar", "cs-managers"],
            {
              account: "Northstar Medical",
              status: "Not Started",
              updatedStatus: "Completed",
              subject: "Follow up on stakeholder questions from yesterday",
            },
            { assignmentRoleTemplateId: "role-customer-success-ic", updatedAfterHours: 4 },
          ),
          record(
            "workday-gainsight-health-note",
            "gainsight",
            "TimelineActivity",
            "Summit Foods health note",
            "role-customer-success-ic",
            ["account-summit", "cs-managers"],
            {
              account: "Summit Foods",
              status: "open",
              updatedStatus: "closed",
              summary: "CS logs a routine health note and a question for Product.",
            },
            { assignmentRoleTemplateId: "role-customer-success-manager", updatedAfterHours: 6 },
          ),
          record(
            "workday-productboard-feedback",
            "productboard",
            "note",
            "Workflow export feedback triage",
            "role-product-ic",
            ["product-core", "product-managers"],
            {
              customer: "Summit Foods",
              productArea: "Workflow Hub",
              status: "new",
              priorityNote: "Routine feedback triage from the CS handoff.",
            },
            { assignmentRoleTemplateId: "role-product-manager" },
          ),
          record(
            "workday-amplitude-snapshot",
            "amplitude",
            "metric_snapshot",
            "Morning activation snapshot",
            "role-product-ic",
            ["product-core"],
            {
              metric: "workflow_activation",
              sevenDayChangePct: 3,
              correctedSevenDayChangePct: 5,
              cohort: "enterprise",
              summary: "Routine adoption check with a later instrumentation correction.",
            },
            { updatedAfterHours: 5 },
          ),
        ],
      },
      {
        id: "delivery-follow-through",
        label: "Delivery follow-through",
        atHour: 4,
        records: [
          record(
            "workday-jira-task",
            "jira",
            "story",
            "Connector retry polish task",
            "role-engineering-manager",
            ["engineering-platform"],
            {
              projectKey: "ENG",
              issueKey: "ENG-2091",
              status: "In Progress",
              updatedStatus: "Done",
              priority: "Medium",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 8 },
          ),
          record(
            "workday-github-pr",
            "github",
            "pull_request",
            "Tighten connector retry logging",
            "role-engineering-ic",
            ["engineering-platform"],
            {
              repository: "acme/connector-gateway",
              checks: "pending",
              updatedChecks: "passing",
              reviewStatus: "pending",
              updatedReviewStatus: "approved",
            },
            { assignmentRoleTemplateId: "role-engineering-manager", updatedAfterHours: 4 },
          ),
          record(
            "workday-pagerduty-handoff",
            "pagerduty",
            "incident",
            "On-call low latency warning handoff",
            "role-engineering-ic",
            ["incident-response", "engineering-platform"],
            {
              incidentId: "PD-DAY-104",
              severity: "sev4",
              status: "resolved",
              summary: "Routine on-call warning was cleared and handed off in the daily sync.",
            },
          ),
          record(
            "workday-zendesk-question",
            "zendesk",
            "ticket",
            "Workflow setup question routed to PM",
            "role-customer-success-ic",
            ["account-summit", "product-core"],
            {
              account: "Summit Foods",
              ticketId: "ZD-DAY-402",
              severity: "normal",
              status: "open",
              updatedStatus: "pending",
              summary: "Support question is routine but needs product wording before closeout.",
            },
            { assignmentRoleTemplateId: "role-product-ic", updatedAfterHours: 3 },
          ),
        ],
      },
      {
        id: "private-followups-and-rollup",
        label: "Private follow-ups and rollup",
        atHour: 7,
        records: [
          record(
            "workday-engineer-private-note",
            "notion",
            "page",
            "Private focus note for assigned engineer",
            "role-engineering-ic",
            [],
            {
              restricted: true,
              status: "Private",
              summary: "Personal work note for the generated engineer assigned to the task.",
            },
            {
              aclUserRoleTemplateIds: ["role-engineering-ic"],
              assignmentRoleTemplateId: "role-engineering-ic",
            },
          ),
          record(
            "workday-manager-private-followup",
            "gmail",
            "email",
            "Manager coaching follow-up",
            "role-product-manager",
            [],
            {
              restricted: true,
              threadId: "gmail-workday-manager-followup",
              subject: "Follow-up from today's operating sync",
              summary: "Private manager follow-up for the generated Product manager.",
            },
            { aclUserRoleTemplateIds: ["role-product-manager"] },
          ),
          record(
            "workday-unmapped-vendor-note",
            "slack",
            "message",
            "External vendor one-off note",
            "role-engineering-manager",
            ["external-vendor-acl-unmapped"],
            {
              restricted: true,
              channel: "#vendor-diagnostics",
              summary: "Vendor-side note with no simulator group mapping.",
            },
          ),
          record(
            "workday-leadership-rollup",
            "gmail",
            "thread",
            "End of day leadership rollup",
            "role-customer-success-director",
            ["product-leadership", "engineering-leadership", "cs-leadership", "exec-staff"],
            {
              threadId: "gmail-workday-leadership-rollup",
              subject: "Daily operating rollup",
              summary:
                "Leadership rollup connects customer follow-up, product triage, and engineering progress.",
            },
          ),
        ],
      },
    ],
  },
  {
    id: "product-launch-readiness",
    title: "Product launch readiness",
    department: "product",
    description:
      "Launch target pressure with incomplete requirements, customer commitments, engineering dependency, and roadmap risk.",
    participantRoleTemplateIds: [
      "role-product-ic",
      "role-product-manager",
      "role-product-director",
      "role-product-vp",
      "role-engineering-manager",
      "role-customer-success-manager",
    ],
    sourceSystems: ["slack", "gmail", "calendar", "notion", "jira", "productboard", "amplitude"],
    events: [
      {
        id: "baseline",
        label: "Launch room opens",
        atHour: 0,
        records: [
          record(
            "launch-slack-thread",
            "slack",
            "message",
            "Launch readiness thread",
            "role-product-manager",
            ["product-launch-team"],
            {
              channel: "#launch-readiness",
              summary: "Launch readiness review opened with requirements still moving.",
              message: "Launch review is open; dependency details are still moving.",
              reactions: ["eyes", "calendar"],
            },
            { updatedAfterHours: 2 },
          ),
          record(
            "launch-notion-brief",
            "notion",
            "page",
            "Q3 workflow launch brief",
            "role-product-ic",
            ["product-launch-team"],
            {
              database: "Launch Briefs",
              status: "Draft",
              updatedStatus: "Reviewed",
              summary:
                "Brief lists launch goal, incomplete requirements, and customer preview promises.",
            },
            { assignmentRoleTemplateId: "role-product-manager", updatedAfterHours: 16 },
          ),
          record(
            "launch-calendar-review",
            "calendar",
            "meeting",
            "Workflow launch review",
            "role-product-director",
            ["product-launch-team", "product-leadership"],
            {
              agenda: "Readiness, dependency risk, customer commitments",
              status: "confirmed",
              updatedStatus: "rescheduled",
            },
            { updatedAfterHours: 30 },
          ),
        ],
      },
      {
        id: "customer-commitment",
        label: "Customer commitment appears",
        atHour: 8,
        records: [
          record(
            "launch-gmail-commitment",
            "gmail",
            "email",
            "Enterprise preview commitment",
            "role-product-manager",
            ["product-managers", "product-leadership", "exec-staff"],
            {
              threadId: "gmail-launch-commitment",
              subject: "Preview timeline for Northstar",
              labels: ["customers", "launch"],
              account: "Northstar Medical",
              summary: "Customer preview promise arrives later than the launch room expects.",
            },
            { visibleAfterHours: 4 },
          ),
          record(
            "launch-productboard-insight",
            "productboard",
            "insight",
            "Preview customer expects workflow export",
            "role-product-manager",
            ["product-launch-team", "product-managers"],
            {
              featureId: "pb-feature-workflow-export",
              productArea: "Workflow Hub",
              customer: "Northstar Medical",
              status: "linked",
              priorityNote: "Commitment tied to preview date.",
            },
            { assignmentRoleTemplateId: "role-product-ic", updatedAfterHours: 10 },
          ),
        ],
      },
      {
        id: "dependency-risk",
        label: "Engineering dependency slips",
        atHour: 24,
        records: [
          record(
            "launch-jira-dependency",
            "jira",
            "issue",
            "Workflow export API dependency",
            "role-engineering-manager",
            ["product-launch-team", "engineering-platform"],
            {
              projectKey: "PROD",
              issueKey: "PROD-214",
              status: "Blocked",
              updatedStatus: "In Review",
              priority: "High",
              dependencies: ["export-api"],
              summary: "Engineering dependency blocks the launch path.",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 6 },
          ),
          record(
            "launch-amplitude-adoption",
            "amplitude",
            "metric_snapshot",
            "Beta workflow adoption dipped",
            "role-product-ic",
            ["product-launch-team"],
            {
              chartId: "amp-workflow-beta",
              metric: "beta_workflow_adoption",
              sevenDayChangePct: -18,
              correctedSevenDayChangePct: -11,
              cohort: "beta",
              summary:
                "Analytics initially show a steep dip, then correct after delayed instrumentation.",
            },
            { visibleAfterHours: 6, updatedAfterHours: 18 },
          ),
          record(
            "launch-slack-director-escalation",
            "slack",
            "thread",
            "Launch dependency director escalation",
            "role-product-director",
            ["product-leadership", "engineering-leadership"],
            {
              channel: "#release-dependencies",
              channelType: "private",
              summary: "Director asks Engineering leadership for dependency options.",
            },
          ),
        ],
      },
      {
        id: "exec-pressure",
        label: "Executive pressure lands",
        atHour: 36,
        manual: true,
        records: [
          record(
            "launch-exec-email",
            "gmail",
            "email",
            "Launch date question for staff",
            "role-product-vp",
            ["exec-staff"],
            {
              threadId: "gmail-exec-launch",
              subject: "Friday staff launch readout",
              sensitivity: "executive",
              summary: "VP asks for confidence and customer exposure summary.",
            },
          ),
          record(
            "launch-decision-log",
            "notion",
            "decision_log",
            "Launch decision update",
            "role-product-director",
            ["product-leadership", "exec-staff"],
            {
              database: "Decision Logs",
              status: "Open",
              updatedStatus: "Decision recorded",
              summary:
                "Decision log captures revised launch criteria without generating a conclusion.",
            },
            { updatedAfterHours: 8 },
          ),
        ],
      },
    ],
  },
  {
    id: "feature-adoption-lag",
    title: "Feature adoption lag",
    department: "product",
    description:
      "Released feature shows uneven usage, conflicting feedback, support friction, and executive portfolio concern.",
    participantRoleTemplateIds: [
      "role-product-ic",
      "role-product-manager",
      "role-product-director",
      "role-product-vp",
      "role-customer-success-ic",
    ],
    sourceSystems: ["amplitude", "productboard", "zendesk", "slack", "gmail", "notion"],
    events: [
      {
        id: "feature-released",
        label: "Feature released",
        atHour: 0,
        records: [
          record(
            "adoption-release-note",
            "notion",
            "page",
            "Workflow analytics release note",
            "role-product-ic",
            ["product-core"],
            {
              status: "Published",
              summary: "Release note marks feature available to beta cohort.",
            },
          ),
          record(
            "adoption-amp-baseline",
            "amplitude",
            "metric_snapshot",
            "Workflow analytics initial adoption",
            "role-product-ic",
            ["product-core"],
            {
              metric: "weekly_active_accounts",
              activeUsers: 42,
              sevenDayChangePct: 4,
              cohort: "beta",
            },
          ),
        ],
      },
      {
        id: "usage-below-expectation",
        label: "Usage below expectation",
        atHour: 18,
        records: [
          record(
            "adoption-amp-decline",
            "amplitude",
            "cohort",
            "Workflow analytics adoption lag",
            "role-product-ic",
            ["product-core", "product-managers"],
            {
              metric: "workflow_analytics_use",
              sevenDayChangePct: -23,
              correctedSevenDayChangePct: -15,
              cohort: "enterprise_beta",
              summary: "Delayed analytics correction softens but does not remove the decline.",
            },
            { visibleAfterHours: 8, updatedAfterHours: 20 },
          ),
          record(
            "adoption-productboard-feedback",
            "productboard",
            "insight",
            "Admins cannot find analytics entry point",
            "role-product-manager",
            ["product-core", "product-managers"],
            {
              customer: "Summit Foods",
              productArea: "Workflow Hub",
              priorityNote: "Discovery friction may be masking value.",
            },
            { assignmentRoleTemplateId: "role-product-ic" },
          ),
          record(
            "adoption-zendesk-friction",
            "zendesk",
            "ticket",
            "Analytics setup question reopened",
            "role-customer-success-ic",
            ["account-summit", "product-launch-team"],
            {
              account: "Summit Foods",
              ticketId: "ZD-2042",
              severity: "normal",
              status: "solved",
              updatedStatus: "reopened",
              summary: "Support issue reopens after customer cannot complete setup.",
            },
            { assignmentRoleTemplateId: "role-product-ic", updatedAfterHours: 12 },
          ),
        ],
      },
      {
        id: "root-cause-disagreement",
        label: "Root cause disagreement",
        atHour: 36,
        records: [
          record(
            "adoption-slack-disagreement",
            "slack",
            "thread",
            "Adoption root cause disagreement",
            "role-product-manager",
            ["product-managers", "cs-managers"],
            {
              channel: "#product-cs-feedback",
              summary: "Product sees discovery friction while CS sees enablement gap.",
            },
          ),
          record(
            "adoption-gmail-enablement",
            "gmail",
            "thread",
            "Enablement follow-up for workflow analytics",
            "role-customer-success-manager",
            ["cs-managers", "product-managers"],
            {
              subject: "Enablement gap vs product friction",
              labels: ["enablement", "customer-feedback"],
              summary: "Email thread frames enablement as the primary gap.",
            },
            { visibleAfterHours: 6 },
          ),
        ],
      },
      {
        id: "portfolio-review",
        label: "Director and VP review",
        atHour: 58,
        manual: true,
        records: [
          record(
            "adoption-director-review",
            "notion",
            "decision_log",
            "Adoption lag review notes",
            "role-product-director",
            ["product-leadership"],
            {
              status: "Open",
              summary: "Director review captures conflicting evidence and next experiments.",
            },
            { updatedAfterHours: 10 },
          ),
          record(
            "adoption-vp-portfolio",
            "gmail",
            "email",
            "Portfolio adoption concern",
            "role-product-vp",
            ["exec-staff", "product-leadership"],
            {
              subject: "Adoption readout for portfolio review",
              summary: "VP asks whether lag changes portfolio sequencing.",
            },
          ),
        ],
      },
    ],
  },
  {
    id: "roadmap-tradeoff",
    title: "Roadmap tradeoff",
    department: "product",
    description:
      "Urgent customer request collides with strategic platform work and limited Engineering capacity.",
    participantRoleTemplateIds: [
      "role-product-manager",
      "role-product-director",
      "role-product-vp",
      "role-engineering-manager",
      "role-customer-success-manager",
    ],
    sourceSystems: ["productboard", "gmail", "jira", "calendar", "notion", "slack"],
    events: [
      {
        id: "competing-demands",
        label: "Competing roadmap demands",
        atHour: 0,
        records: [
          record(
            "tradeoff-productboard-request",
            "productboard",
            "feature",
            "Customer SSO exception request",
            "role-product-manager",
            ["product-managers", "account-northstar"],
            {
              customer: "Northstar Medical",
              productArea: "Identity",
              roadmapPosition: "candidate",
              priorityNote: "Urgent customer request.",
            },
          ),
          record(
            "tradeoff-platform-note",
            "notion",
            "page",
            "Strategic platform investment note",
            "role-product-director",
            ["product-leadership", "engineering-leadership"],
            {
              status: "Draft",
              summary: "Strategic investment requires the same Engineering team.",
            },
          ),
        ],
      },
      {
        id: "capacity-evidence",
        label: "Capacity evidence appears",
        atHour: 14,
        records: [
          record(
            "tradeoff-jira-capacity",
            "jira",
            "epic",
            "Identity platform capacity constraint",
            "role-engineering-manager",
            ["engineering-platform", "product-managers"],
            {
              projectKey: "IDP",
              issueKey: "IDP-331",
              status: "At Risk",
              updatedStatus: "Deferred",
              priority: "High",
              dependencies: ["security-review"],
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 20 },
          ),
          record(
            "tradeoff-customer-email",
            "gmail",
            "email",
            "Customer request commitment pressure",
            "role-customer-success-manager",
            ["account-northstar", "product-managers"],
            {
              subject: "Northstar SSO exception timing",
              labels: ["customer", "roadmap"],
              summary: "CS asks whether Product can commit a date.",
            },
            { visibleAfterHours: 5 },
          ),
        ],
      },
      {
        id: "director-tradeoff",
        label: "Director tradeoff discussion",
        atHour: 32,
        records: [
          record(
            "tradeoff-calendar-review",
            "calendar",
            "meeting",
            "Roadmap tradeoff review",
            "role-product-director",
            ["product-leadership", "engineering-leadership", "cs-leadership"],
            { agenda: "Capacity, customer promise, deferred investment", status: "confirmed" },
          ),
          record(
            "tradeoff-slack-directors",
            "slack",
            "thread",
            "Roadmap tradeoff director thread",
            "role-product-director",
            ["product-leadership", "engineering-leadership"],
            {
              channel: "#portfolio-tradeoffs",
              channelType: "private",
              summary: "Directors discuss sequencing and one deferred item.",
            },
          ),
        ],
      },
      {
        id: "vp-decision",
        label: "VP decision and follow-up",
        atHour: 54,
        manual: true,
        records: [
          record(
            "tradeoff-vp-email",
            "gmail",
            "thread",
            "Roadmap tradeoff decision follow-up",
            "role-product-vp",
            ["exec-staff"],
            {
              subject: "Roadmap tradeoff decision",
              summary: "VP records decision and asks teams to update sources.",
            },
          ),
          record(
            "tradeoff-productboard-update",
            "productboard",
            "feature",
            "SSO exception request deferred",
            "role-product-manager",
            ["product-managers", "account-northstar"],
            {
              customer: "Northstar Medical",
              status: "candidate",
              updatedStatus: "deferred",
              roadmapPosition: "later",
              priorityNote: "Deferred after capacity review.",
            },
            { updatedAfterHours: 8 },
          ),
        ],
      },
    ],
  },
  {
    id: "reliability-incident",
    title: "Reliability incident",
    department: "engineering",
    description:
      "Service degradation with incident response, GitHub fix, customer escalation, and postmortem.",
    participantRoleTemplateIds: [
      "role-engineering-ic",
      "role-engineering-manager",
      "role-engineering-director",
      "role-engineering-vp",
      "role-customer-success-manager",
    ],
    sourceSystems: [
      "pagerduty",
      "slack",
      "github",
      "jira",
      "calendar",
      "notion",
      "gmail",
      "zendesk",
    ],
    events: [
      {
        id: "incident-opened",
        label: "Incident opens",
        atHour: 0,
        records: [
          record(
            "incident-pagerduty",
            "pagerduty",
            "incident",
            "Ingestion latency degradation",
            "role-engineering-ic",
            ["incident-response", "engineering-platform"],
            {
              incidentId: "PD-8842",
              severity: "sev2",
              status: "triggered",
              updatedStatus: "acknowledged",
              summary: "PagerDuty triggers for ingestion latency.",
            },
            { assignmentRoleTemplateId: "role-engineering-manager", updatedAfterHours: 4 },
          ),
          record(
            "incident-slack-channel",
            "slack",
            "message",
            "SEV2 incident channel opened",
            "role-engineering-manager",
            ["incident-response"],
            {
              channel: "#inc-ingestion-latency",
              summary: "SEV2 declared. First look points at queue saturation.",
            },
          ),
          record(
            "incident-zendesk-customer",
            "zendesk",
            "ticket",
            "Customer ingestion latency escalation",
            "role-customer-success-manager",
            ["account-northstar", "incident-response"],
            {
              account: "Northstar Medical",
              ticketId: "ZD-8842",
              severity: "high",
              escalation: true,
              status: "open",
            },
            { assignmentRoleTemplateId: "role-engineering-manager", updatedAfterHours: 18 },
          ),
        ],
      },
      {
        id: "fix-in-flight",
        label: "Fix work starts",
        atHour: 5,
        records: [
          record(
            "incident-github-pr",
            "github",
            "pull_request",
            "Throttle connector retries under queue pressure",
            "role-engineering-ic",
            ["engineering-platform", "incident-response"],
            {
              repository: "acme/connector-gateway",
              number: 418,
              checks: "failing",
              updatedChecks: "passing",
              reviewStatus: "changes_requested",
              updatedReviewStatus: "approved",
              updatedStatus: "merged",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 3 },
          ),
          record(
            "incident-jira",
            "jira",
            "issue",
            "Backfill retry controls for connector queue",
            "role-engineering-manager",
            ["engineering-platform", "engineering-managers"],
            {
              projectKey: "ENG",
              issueKey: "ENG-1842",
              status: "In Progress",
              updatedStatus: "Done",
              priority: "High",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 16 },
          ),
        ],
      },
      {
        id: "postmortem-scheduled",
        label: "Postmortem scheduled",
        atHour: 22,
        records: [
          record(
            "incident-calendar-postmortem",
            "calendar",
            "meeting",
            "Ingestion latency postmortem",
            "role-engineering-manager",
            ["incident-response", "engineering-leadership"],
            {
              eventId: "cal-postmortem-8842",
              attendeeRoles: ["engineering", "customer_success"],
              status: "confirmed",
            },
          ),
          record(
            "incident-notion-postmortem",
            "notion",
            "page",
            "PD-8842 postmortem draft",
            "role-engineering-manager",
            ["engineering-leadership"],
            {
              pageId: "notion-pd-8842",
              status: "Draft",
              updatedStatus: "Published",
              openQuestions: 3,
            },
            { assignmentRoleTemplateId: "role-engineering-director", updatedAfterHours: 12 },
          ),
        ],
      },
      {
        id: "exec-incident-summary",
        label: "VP incident summary",
        atHour: 30,
        manual: true,
        records: [
          record(
            "incident-vp-summary",
            "gmail",
            "email",
            "Executive incident summary",
            "role-engineering-vp",
            ["exec-staff"],
            { threadId: "gmail-incident-exec", subject: "SEV2 customer impact and remediation" },
          ),
          record(
            "incident-followup-reopened",
            "jira",
            "bug",
            "Retry control follow-up reopened",
            "role-engineering-manager",
            ["engineering-platform", "engineering-leadership"],
            {
              projectKey: "ENG",
              issueKey: "ENG-1855",
              status: "Closed",
              updatedStatus: "Reopened",
              priority: "Medium",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 20 },
          ),
        ],
      },
    ],
  },
  {
    id: "migration-delivery-slip",
    title: "Migration or delivery slip",
    department: "engineering",
    description:
      "Planned migration slips due to dependency, review delay, availability risk, and customer commitment impact.",
    participantRoleTemplateIds: [
      "role-engineering-ic",
      "role-engineering-manager",
      "role-engineering-director",
      "role-engineering-vp",
      "role-product-manager",
      "role-customer-success-manager",
    ],
    sourceSystems: ["jira", "github", "calendar", "slack", "gmail", "notion", "salesforce"],
    events: [
      {
        id: "migration-planned",
        label: "Migration planned",
        atHour: 0,
        records: [
          record(
            "migration-jira-epic",
            "jira",
            "epic",
            "Connector tenancy migration epic",
            "role-engineering-manager",
            ["engineering-platform"],
            {
              projectKey: "MIG",
              issueKey: "MIG-120",
              status: "In Progress",
              priority: "High",
              dueDate: "2026-07-20",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 36 },
          ),
          record(
            "migration-notion-design",
            "notion",
            "page",
            "Tenancy migration design note",
            "role-engineering-ic",
            ["engineering-platform"],
            {
              status: "Draft",
              updatedStatus: "Reviewed",
              summary: "Design note tracks dependency and rollback plan.",
            },
            { updatedAfterHours: 12 },
          ),
        ],
      },
      {
        id: "review-delay",
        label: "GitHub review delay",
        atHour: 20,
        records: [
          record(
            "migration-github-pr",
            "github",
            "pull_request",
            "Move connector tenancy index",
            "role-engineering-ic",
            ["engineering-platform"],
            {
              repository: "acme/connector-gateway",
              checks: "passing",
              reviewStatus: "waiting",
              updatedReviewStatus: "changes_requested",
            },
            { assignmentRoleTemplateId: "role-engineering-manager", updatedAfterHours: 18 },
          ),
          record(
            "migration-github-commit",
            "github",
            "commit",
            "Connector tenancy index commit",
            "role-engineering-ic",
            ["engineering-platform"],
            {
              repository: "acme/connector-gateway",
              path: "src/tenancy/index.ts",
              summary: "Commit updates tenancy index lookup before review.",
            },
            { assignmentRoleTemplateId: "role-engineering-manager" },
          ),
          record(
            "migration-calendar-ooo",
            "calendar",
            "event",
            "Key engineer availability gap",
            "role-engineering-manager",
            ["engineering-managers"],
            { agenda: "Coverage plan while senior engineer is unavailable", status: "confirmed" },
          ),
        ],
      },
      {
        id: "customer-impact",
        label: "Customer commitment impact",
        atHour: 44,
        records: [
          record(
            "migration-gmail-customer-impact",
            "gmail",
            "thread",
            "Migration date impact for customer commitment",
            "role-customer-success-manager",
            ["account-northstar", "product-managers"],
            {
              subject: "Migration timeline and customer preview",
              labels: ["customer", "migration"],
            },
            { visibleAfterHours: 8 },
          ),
          record(
            "migration-slack-escalation",
            "slack",
            "thread",
            "Migration slip manager escalation",
            "role-engineering-manager",
            ["engineering-managers", "product-managers"],
            {
              channel: "#migration-room",
              summary: "Manager escalates revised date and dependency.",
            },
          ),
        ],
      },
      {
        id: "director-intervention",
        label: "Director intervention",
        atHour: 68,
        manual: true,
        records: [
          record(
            "migration-director-note",
            "notion",
            "decision_log",
            "Migration revised date decision",
            "role-engineering-director",
            ["engineering-leadership", "product-leadership"],
            {
              status: "Open",
              updatedStatus: "Decision recorded",
              summary: "Director records revised date and dependency owner.",
            },
            { updatedAfterHours: 6 },
          ),
          record(
            "migration-vp-visibility",
            "gmail",
            "email",
            "Migration slip portfolio note",
            "role-engineering-vp",
            ["exec-staff"],
            {
              subject: "Migration slip and customer exposure",
              summary: "VP receives a portfolio-level note.",
            },
          ),
        ],
      },
    ],
  },
  {
    id: "technical-debt-staffing-risk",
    title: "Technical debt and staffing risk",
    department: "engineering",
    description:
      "Recurring defects and concentrated knowledge create staffing and investment risk without scoring individuals.",
    participantRoleTemplateIds: [
      "role-engineering-ic",
      "role-engineering-manager",
      "role-engineering-director",
      "role-engineering-vp",
    ],
    sourceSystems: ["jira", "github", "pagerduty", "notion", "slack", "calendar", "gmail"],
    events: [
      {
        id: "recurring-defects",
        label: "Recurring defects appear",
        atHour: 0,
        records: [
          record(
            "debt-jira-bug-cluster",
            "jira",
            "bug",
            "Recurring connector retry defects",
            "role-engineering-manager",
            ["engineering-platform"],
            {
              projectKey: "ENG",
              issueKey: "ENG-2100",
              status: "Open",
              priority: "High",
              dependencies: ["retry-library"],
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 30 },
          ),
          record(
            "debt-pagerduty-pattern",
            "pagerduty",
            "incident",
            "Repeated queue saturation alerts",
            "role-engineering-ic",
            ["incident-response", "engineering-platform"],
            { severity: "sev3", status: "triggered", updatedStatus: "resolved" },
            { updatedAfterHours: 6 },
          ),
        ],
      },
      {
        id: "knowledge-concentration",
        label: "Concentrated knowledge risk",
        atHour: 24,
        records: [
          record(
            "debt-notion-staffing-note",
            "notion",
            "page",
            "Retry subsystem staffing risk note",
            "role-engineering-manager",
            ["engineering-managers", "engineering-leadership"],
            {
              status: "Draft",
              summary:
                "Note describes knowledge concentration and coverage gaps without person scoring.",
            },
            { updatedAfterHours: 16 },
          ),
          record(
            "debt-calendar-1-1",
            "calendar",
            "meeting",
            "Manager one-on-one coverage discussion",
            "role-engineering-manager",
            ["engineering-managers"],
            { agenda: "Coverage, pairing, and sustainable remediation plan", recurring: true },
          ),
        ],
      },
      {
        id: "capacity-planning",
        label: "Capacity planning tradeoff",
        atHour: 52,
        records: [
          record(
            "debt-slack-capacity",
            "slack",
            "thread",
            "Capacity planning for retry remediation",
            "role-engineering-director",
            ["engineering-leadership"],
            {
              channel: "#eng-capacity",
              channelType: "private",
              summary: "Director weighs remediation against roadmap capacity.",
            },
          ),
          record(
            "debt-github-remediation",
            "github",
            "issue",
            "Extract retry controls into shared library",
            "role-engineering-ic",
            ["engineering-platform"],
            { repository: "acme/connector-gateway", status: "open", reviewStatus: "not_started" },
            { assignmentRoleTemplateId: "role-engineering-manager" },
          ),
        ],
      },
      {
        id: "vp-investment",
        label: "VP investment discussion",
        atHour: 80,
        manual: true,
        records: [
          record(
            "debt-vp-email",
            "gmail",
            "email",
            "Retry platform investment discussion",
            "role-engineering-vp",
            ["exec-staff", "engineering-leadership"],
            {
              subject: "Investment option for reliability debt",
              summary: "VP discusses investment options, not employee performance.",
            },
          ),
          record(
            "debt-jira-deferred",
            "jira",
            "task",
            "Deferred retry remediation item",
            "role-engineering-director",
            ["engineering-leadership"],
            { projectKey: "ENG", issueKey: "ENG-2135", status: "Deferred", priority: "Medium" },
            { deletedAfterHours: 36 },
          ),
        ],
      },
    ],
  },
  {
    id: "renewal-risk",
    title: "Renewal risk",
    department: "customer_success",
    description:
      "Sponsor silence, support volume, weak adoption, and commercial renewal pressure converge.",
    participantRoleTemplateIds: [
      "role-customer-success-ic",
      "role-customer-success-manager",
      "role-customer-success-director",
      "role-customer-success-vp",
      "role-product-manager",
    ],
    sourceSystems: [
      "salesforce",
      "gmail",
      "zendesk",
      "gainsight",
      "slack",
      "calendar",
      "productboard",
    ],
    events: [
      {
        id: "baseline",
        label: "Renewal workspace active",
        atHour: 0,
        records: [
          record(
            "renewal-salesforce-account",
            "salesforce",
            "account",
            "Northstar Medical account",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            { account: "Northstar Medical", accountType: "Customer", industry: "Healthcare" },
          ),
          record(
            "renewal-salesforce-contact",
            "salesforce",
            "contact",
            "Northstar executive sponsor",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              account: "Northstar Medical",
              firstName: "Fictional",
              lastName: "Sponsor",
              email: "northstar.sponsor@example.test",
              contactTitle: "Executive Sponsor",
            },
          ),
          record(
            "renewal-salesforce-oppty",
            "salesforce",
            "opportunity",
            "Northstar Medical renewal",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              account: "Northstar Medical",
              status: "Renewal",
              amount: 245000,
              closeDate: "2026-08-15",
              riskState: "watch",
            },
            { assignmentRoleTemplateId: "role-customer-success-manager", updatedAfterHours: 48 },
          ),
          record(
            "renewal-gainsight-health",
            "gainsight",
            "health_score",
            "Northstar health score",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              account: "Northstar Medical",
              score: 63,
              updatedScore: 51,
              trend: "down",
              stale: true,
              riskReason: "adoption decline",
            },
            { updatedAfterHours: 12 },
          ),
        ],
      },
      {
        id: "support-escalation",
        label: "Support escalation grows",
        atHour: 12,
        records: [
          record(
            "renewal-zendesk-ticket",
            "zendesk",
            "ticket",
            "Northstar export failure escalation",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              account: "Northstar Medical",
              ticketId: "ZD-9917",
              severity: "high",
              status: "open",
              updatedStatus: "reopened",
              escalation: true,
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 30 },
          ),
          record(
            "renewal-product-gap",
            "productboard",
            "insight",
            "Northstar product gap linked to renewal",
            "role-product-manager",
            ["account-northstar", "product-managers"],
            {
              customer: "Northstar Medical",
              productArea: "Workflow Export",
              priorityNote: "Product gap tied to renewal confidence.",
            },
          ),
          record(
            "renewal-slack-escalation",
            "slack",
            "message",
            "Northstar renewal risk thread",
            "role-customer-success-manager",
            ["cs-managers", "account-northstar"],
            {
              channel: "#cs-renewals",
              summary: "Support escalation is now tied to renewal confidence.",
            },
          ),
        ],
      },
      {
        id: "sponsor-silent",
        label: "Sponsor goes quiet",
        atHour: 28,
        records: [
          record(
            "renewal-gmail-sponsor",
            "gmail",
            "email",
            "Northstar sponsor follow-up",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              threadId: "gmail-northstar-followup",
              subject: "Checking in on renewal next steps",
              replyStatus: "no_response",
            },
            { visibleAfterHours: 10 },
          ),
          record(
            "renewal-calendar-qbr",
            "calendar",
            "meeting",
            "Northstar QBR rescheduled",
            "role-customer-success-manager",
            ["account-northstar", "cs-managers"],
            {
              eventId: "cal-northstar-qbr",
              status: "confirmed",
              updatedStatus: "rescheduled",
              previousTime: "2026-07-12T18:00:00.000Z",
            },
            { updatedAfterHours: 4 },
          ),
        ],
      },
      {
        id: "vp-risk",
        label: "VP renewal risk review",
        atHour: 42,
        manual: true,
        records: [
          record(
            "renewal-vp-brief",
            "salesforce",
            "opportunity_update",
            "Northstar marked at risk",
            "role-customer-success-vp",
            ["cs-leadership", "exec-staff"],
            {
              account: "Northstar Medical",
              status: "Renewal Risk",
              nextStep: "Executive sponsor outreach",
              riskState: "high",
            },
          ),
          record(
            "renewal-director-outreach",
            "gmail",
            "thread",
            "Director executive outreach for Northstar",
            "role-customer-success-director",
            ["cs-leadership", "account-northstar"],
            {
              subject: "Executive sponsor outreach for Northstar",
              labels: ["renewal", "exec-outreach"],
            },
          ),
        ],
      },
    ],
  },
  {
    id: "implementation-blocker",
    title: "Implementation blocker",
    department: "customer_success",
    description:
      "Customer implementation slips due to integration dependency, ownership confusion, and cross-functional recovery.",
    participantRoleTemplateIds: [
      "role-customer-success-ic",
      "role-customer-success-manager",
      "role-engineering-manager",
      "role-product-manager",
      "role-customer-success-director",
    ],
    sourceSystems: ["gainsight", "salesforce", "zendesk", "slack", "jira", "calendar", "notion"],
    events: [
      {
        id: "blocker-opened",
        label: "Implementation blocker opened",
        atHour: 0,
        records: [
          record(
            "impl-gainsight-cta",
            "gainsight",
            "cta",
            "Summit implementation blocker CTA",
            "role-customer-success-ic",
            ["account-summit", "cs-east"],
            {
              account: "Summit Foods",
              status: "open",
              riskReason: "integration dependency",
              milestone: "ERP connector",
            },
            { assignmentRoleTemplateId: "role-customer-success-manager", updatedAfterHours: 24 },
          ),
          record(
            "impl-salesforce-activity",
            "salesforce",
            "activity",
            "Summit implementation milestone slip",
            "role-customer-success-ic",
            ["account-summit", "cs-east"],
            {
              account: "Summit Foods",
              stage: "Implementation",
              closeDate: "2026-07-25",
              updatedCloseDate: "2026-08-05",
            },
            { updatedAfterHours: 48 },
          ),
        ],
      },
      {
        id: "ownership-confusion",
        label: "Ownership confusion",
        atHour: 18,
        records: [
          record(
            "impl-zendesk-ticket",
            "zendesk",
            "ticket",
            "ERP connector setup blocked",
            "role-customer-success-ic",
            ["account-summit", "engineering-platform"],
            { account: "Summit Foods", severity: "high", escalation: true, status: "open" },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 18 },
          ),
          record(
            "impl-slack-escalation",
            "slack",
            "thread",
            "Summit implementation ownership escalation",
            "role-customer-success-manager",
            ["account-summit", "product-managers", "engineering-managers"],
            {
              channel: "#summit-implementation",
              summary: "CS, Product, and Engineering clarify owner for integration dependency.",
            },
          ),
        ],
      },
      {
        id: "engineering-blocker",
        label: "Engineering blocker logged",
        atHour: 36,
        records: [
          record(
            "impl-jira-blocker",
            "jira",
            "issue",
            "ERP connector field mapping blocker",
            "role-engineering-manager",
            ["engineering-platform", "account-summit"],
            {
              projectKey: "INT",
              issueKey: "INT-77",
              status: "Blocked",
              updatedStatus: "In Progress",
              priority: "High",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 12 },
          ),
          record(
            "impl-notion-plan",
            "notion",
            "page",
            "Summit revised implementation plan",
            "role-customer-success-manager",
            ["account-summit", "cs-managers"],
            {
              status: "Draft",
              updatedStatus: "Shared",
              summary: "Revised plan separates customer task from Engineering dependency.",
            },
            { updatedAfterHours: 10 },
          ),
        ],
      },
      {
        id: "recovery-meeting",
        label: "Cross-functional recovery meeting",
        atHour: 58,
        manual: true,
        records: [
          record(
            "impl-calendar-recovery",
            "calendar",
            "meeting",
            "Summit recovery plan review",
            "role-customer-success-director",
            ["account-summit", "product-leadership", "engineering-leadership"],
            { agenda: "Recovery owner, revised date, customer communication", status: "confirmed" },
          ),
          record(
            "impl-director-summary",
            "gmail",
            "thread",
            "Summit recovery plan summary",
            "role-customer-success-director",
            ["cs-leadership", "product-leadership", "engineering-leadership"],
            { subject: "Summit implementation recovery plan" },
          ),
        ],
      },
    ],
  },
  {
    id: "expansion-opportunity",
    title: "Expansion opportunity",
    department: "customer_success",
    description:
      "Positive usage and executive interest create an expansion path with product gaps and procurement uncertainty.",
    participantRoleTemplateIds: [
      "role-customer-success-ic",
      "role-customer-success-manager",
      "role-product-manager",
      "role-engineering-manager",
      "role-customer-success-vp",
    ],
    sourceSystems: [
      "amplitude",
      "salesforce",
      "gainsight",
      "productboard",
      "github",
      "gmail",
      "calendar",
    ],
    events: [
      {
        id: "positive-usage",
        label: "Positive usage detected",
        atHour: 0,
        records: [
          record(
            "expansion-amp-usage",
            "amplitude",
            "metric_snapshot",
            "Northstar automation usage increase",
            "role-product-ic",
            ["account-northstar", "product-managers"],
            {
              account: "Northstar Medical",
              metric: "automation_runs",
              sevenDayChangePct: 31,
              activeUsers: 85,
              cohort: "enterprise",
            },
          ),
          record(
            "expansion-gainsight-milestone",
            "gainsight",
            "milestone",
            "Northstar adoption milestone completed",
            "role-customer-success-ic",
            ["account-northstar", "cs-east"],
            {
              account: "Northstar Medical",
              milestone: "Automation rollout",
              status: "complete",
              score: 82,
            },
          ),
        ],
      },
      {
        id: "executive-interest",
        label: "Executive interest",
        atHour: 18,
        records: [
          record(
            "expansion-gmail-exec-interest",
            "gmail",
            "thread",
            "Executive interest in new use case",
            "role-customer-success-manager",
            ["account-northstar", "cs-managers"],
            {
              subject: "New automation use case",
              labels: ["expansion"],
              summary: "Customer executive asks about adjacent workflow.",
            },
            { visibleAfterHours: 6 },
          ),
          record(
            "expansion-salesforce-oppty",
            "salesforce",
            "opportunity",
            "Northstar automation expansion",
            "role-customer-success-manager",
            ["account-northstar", "cs-managers"],
            {
              account: "Northstar Medical",
              amount: 180000,
              status: "Discovery",
              closeDate: "2026-09-15",
              updatedCloseDate: "2026-10-01",
              procurementDelay: true,
            },
            { updatedAfterHours: 60 },
          ),
        ],
      },
      {
        id: "product-gap",
        label: "Product gap and feasibility",
        atHour: 36,
        records: [
          record(
            "expansion-productboard-gap",
            "productboard",
            "insight",
            "Expansion use case needs bulk approval",
            "role-product-manager",
            ["account-northstar", "product-managers"],
            {
              customer: "Northstar Medical",
              productArea: "Approvals",
              priorityNote: "Gap blocks full expansion confidence.",
            },
          ),
          record(
            "expansion-github-feasibility",
            "github",
            "issue",
            "Bulk approval feasibility note",
            "role-engineering-manager",
            ["engineering-platform", "product-managers"],
            { repository: "acme/workflow-hub", reviewStatus: "not_started", status: "open" },
            { assignmentRoleTemplateId: "role-engineering-ic" },
          ),
        ],
      },
      {
        id: "procurement-delay",
        label: "Procurement delay",
        atHour: 72,
        manual: true,
        records: [
          record(
            "expansion-calendar-customer",
            "calendar",
            "meeting",
            "Northstar expansion use-case review",
            "role-customer-success-manager",
            ["account-northstar", "product-managers"],
            { agenda: "Use case, product gap, procurement timing", status: "confirmed" },
          ),
          record(
            "expansion-vp-note",
            "gmail",
            "email",
            "Expansion upside with procurement delay",
            "role-customer-success-vp",
            ["exec-staff", "cs-leadership"],
            {
              subject: "Expansion opportunity and procurement delay",
              summary: "Positive signal remains uncertain due to procurement timing.",
            },
          ),
        ],
      },
    ],
  },
  {
    id: "major-cross-functional-product-release",
    title: "Major cross-functional product release",
    department: "cross_functional",
    description:
      "A broad release connects Product, Engineering, and Customer Success with partial, conflicting, and corrected source evidence.",
    participantRoleTemplateIds: [
      "role-product-ic",
      "role-product-manager",
      "role-product-director",
      "role-product-vp",
      "role-engineering-ic",
      "role-engineering-manager",
      "role-engineering-director",
      "role-engineering-vp",
      "role-customer-success-ic",
      "role-customer-success-manager",
      "role-customer-success-director",
      "role-customer-success-vp",
    ],
    sourceSystems: [
      "slack",
      "gmail",
      "calendar",
      "notion",
      "jira",
      "productboard",
      "amplitude",
      "github",
      "pagerduty",
      "salesforce",
      "gainsight",
      "zendesk",
    ],
    events: [
      {
        id: "release-kickoff",
        label: "Cross-functional release kickoff",
        atHour: 0,
        records: [
          record(
            "xrelease-productboard-roadmap",
            "productboard",
            "feature",
            "Operations Control release roadmap item",
            "role-product-manager",
            ["project-aurora", "product-launch-team"],
            {
              productArea: "Operations Control",
              roadmapPosition: "Q3 committed",
              priorityNote: "Roadmap commitment for executive customer.",
            },
          ),
          record(
            "xrelease-notion-prd",
            "notion",
            "page",
            "Operations Control PRD",
            "role-product-ic",
            ["project-aurora", "product-launch-team"],
            {
              status: "Draft",
              updatedStatus: "Approved",
              summary: "PRD defines launch objective and customer use case.",
            },
            { updatedAfterHours: 20 },
          ),
          record(
            "xrelease-salesforce-commitment",
            "salesforce",
            "activity",
            "Release commitment logged for Northstar",
            "role-customer-success-manager",
            ["project-aurora", "account-northstar"],
            { account: "Northstar Medical", stage: "Commitment", closeDate: "2026-09-01" },
          ),
          record(
            "xrelease-salesforce-event",
            "salesforce",
            "event",
            "Release executive sponsor meeting",
            "role-customer-success-manager",
            ["project-aurora", "account-northstar"],
            {
              account: "Northstar Medical",
              contact: "Northstar executive sponsor",
              summary: "Executive sponsor meeting logged against the account.",
            },
          ),
        ],
      },
      {
        id: "delivery-work",
        label: "Engineering delivery work",
        atHour: 24,
        records: [
          record(
            "xrelease-jira-dependency",
            "jira",
            "story",
            "Operations Control audit dependency",
            "role-engineering-manager",
            ["project-aurora", "engineering-platform"],
            {
              projectKey: "REL",
              issueKey: "REL-402",
              status: "In Progress",
              updatedStatus: "Blocked",
              dependencies: ["audit-log"],
              priority: "High",
            },
            { assignmentRoleTemplateId: "role-engineering-ic", updatedAfterHours: 18 },
          ),
          record(
            "xrelease-github-pr",
            "github",
            "pull_request",
            "Add Operations Control audit stream",
            "role-engineering-ic",
            ["project-aurora", "engineering-platform"],
            {
              repository: "acme/operations-control",
              checks: "failing",
              updatedChecks: "passing",
              reviewStatus: "pending",
              updatedReviewStatus: "approved",
            },
            { assignmentRoleTemplateId: "role-engineering-manager", updatedAfterHours: 12 },
          ),
          record(
            "xrelease-pagerduty-concern",
            "pagerduty",
            "incident",
            "Release candidate audit stream warning",
            "role-engineering-ic",
            ["project-aurora", "incident-response"],
            { severity: "sev3", status: "triggered", updatedStatus: "resolved" },
            { updatedAfterHours: 5 },
          ),
        ],
      },
      {
        id: "customer-enablement",
        label: "Customer enablement and conflicting update",
        atHour: 48,
        records: [
          record(
            "xrelease-gainsight-plan",
            "gainsight",
            "success_plan",
            "Northstar release enablement plan",
            "role-customer-success-ic",
            ["project-aurora", "account-northstar"],
            {
              account: "Northstar Medical",
              status: "open",
              updatedStatus: "at_risk",
              score: 74,
              updatedScore: 69,
            },
          ),
          record(
            "xrelease-zendesk-gap",
            "zendesk",
            "ticket",
            "Release enablement article missing step",
            "role-customer-success-ic",
            ["project-aurora", "account-northstar"],
            {
              account: "Northstar Medical",
              severity: "normal",
              status: "open",
              updatedStatus: "resolved",
            },
            { assignmentRoleTemplateId: "role-product-ic", updatedAfterHours: 22 },
          ),
          record(
            "xrelease-amplitude-conflict",
            "amplitude",
            "metric_snapshot",
            "Release beta usage conflict",
            "role-product-ic",
            ["project-aurora", "product-launch-team"],
            {
              metric: "release_beta_activation",
              sevenDayChangePct: 18,
              correctedSevenDayChangePct: -6,
              cohort: "release_beta",
              summary:
                "Initial usage looks positive, then corrected instrumentation conflicts with it.",
            },
            { visibleAfterHours: 10, updatedAfterHours: 24 },
          ),
        ],
      },
      {
        id: "leadership-readout",
        label: "Leadership launch confidence readout",
        atHour: 84,
        manual: true,
        records: [
          record(
            "xrelease-calendar-exec-review",
            "calendar",
            "meeting",
            "Executive launch confidence review",
            "role-product-vp",
            ["exec-staff", "project-aurora"],
            {
              agenda: "Launch confidence, customer exposure, reliability concern",
              status: "confirmed",
            },
          ),
          record(
            "xrelease-slack-director-thread",
            "slack",
            "thread",
            "Director launch tradeoff thread",
            "role-product-director",
            ["product-leadership", "engineering-leadership", "cs-leadership"],
            {
              channel: "#release-directors",
              channelType: "private",
              summary: "Directors compare readiness, enablement, and reliability evidence.",
            },
          ),
          record(
            "xrelease-github-release",
            "github",
            "release",
            "Operations Control release candidate",
            "role-engineering-manager",
            ["project-aurora", "engineering-platform"],
            {
              repository: "acme/operations-control",
              tagName: "v3.0.0-rc.1",
              prerelease: true,
              summary: "Release candidate published for leadership confidence review.",
            },
          ),
          record(
            "xrelease-vp-readout",
            "gmail",
            "email",
            "Operations Control executive readout",
            "role-product-vp",
            ["exec-staff"],
            {
              subject: "Operations Control launch confidence",
              summary: "VP-level readout summarizes confidence inputs without declaring outcome.",
            },
          ),
        ],
      },
    ],
  },
];

export const scenarios: ScenarioDefinition[] = baseScenarios.map(withRoleWorkArtifacts);

export const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
