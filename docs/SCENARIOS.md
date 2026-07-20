# Scenarios

The simulator implements 11 scenario packs. Packs define reusable business-event templates; source adapters shape how those events appear in provider payloads.

The simulator creates source evidence only. It does not define expected Workforce One conclusions.

## Scenario Packs

| Pack                                     | Departments                            | Key Sources                                                             |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `regular-workday`                        | Product, Engineering, CS               | All 12 source systems                                                   |
| `product-launch-readiness`               | Product, Engineering, CS               | Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude           |
| `feature-adoption-lag`                   | Product, CS                            | Amplitude, Productboard, Zendesk, Slack, Gmail, Notion                  |
| `roadmap-tradeoff`                       | Product, Engineering, CS               | Productboard, Gmail, Jira, Calendar, Notion, Slack                      |
| `reliability-incident`                   | Engineering, CS                        | PagerDuty, Slack, GitHub, Jira, Calendar, Notion, Gmail, Zendesk        |
| `migration-delivery-slip`                | Engineering, Product, CS               | Jira, GitHub, Calendar, Slack, Gmail, Notion, Salesforce                |
| `technical-debt-staffing-risk`           | Engineering                            | Jira, GitHub, PagerDuty, Notion, Slack, Calendar, Gmail                 |
| `renewal-risk`                           | Customer Success, Product, Engineering | Salesforce, Gmail, Zendesk, Gainsight, Slack, Calendar, Productboard    |
| `implementation-blocker`                 | CS, Engineering, Product               | Gainsight, Salesforce, Zendesk, Slack, Jira, Calendar, Notion           |
| `expansion-opportunity`                  | CS, Product, Engineering               | Amplitude, Salesforce, Gainsight, Productboard, GitHub, Gmail, Calendar |
| `major-cross-functional-product-release` | Product, Engineering, CS               | All 12 source systems                                                   |

## Imperfect Data

The packs include late email, Slack edits, corrected analytics, delayed Salesforce updates, reopened Zendesk tickets, GitHub/Jira ordering differences, cancelled/rescheduled meetings, restricted/archived pages, deleted source objects, and sources that disagree or omit context.

## Level-Specific Evidence

- IC artifacts show implementation detail, tickets, pull requests, support investigation, and direct work.
- Manager artifacts show coordination, assignments, escalations, and team status.
- Director artifacts show multi-team dependencies, tradeoffs, and portfolio reviews.
- VP artifacts show executive summaries, launch confidence, customer exposure, and investment discussion.

## Role-Specific Work Artifacts

Every scenario instance automatically includes a `role-specific-work-artifacts` event with one source-native artifact for each participant role in that scenario. These records make each generated individual feel like they have real work in their own systems: a PM can receive a release-readiness email or tracker task, a CSM can receive an escalation/QBR follow-up, and an engineering leader can receive readiness reviews or blocker approvals.

These artifacts are not Workforce One conclusions. They are ordinary simulated source objects routed through the existing adapters, ACL materialization, ledger, and connection feed. Each artifact is private to the generated person assigned to that role, so it reaches the right connection without creating a simulator-only side channel.

The artifact source adapts to the sources available in the scenario. For example, a release-readiness item may appear as Gmail metadata/snippet when Gmail is present, Productboard or Jira when product systems are present, or a Notion page when that is the available source. Workbook references such as `Launch readiness tracker.xlsx` are modeled as source text references only; the simulator does not ingest real attachments.

Selecting a scenario in the operator console is for inspection and manual control. Dataset generation and continuous mode use the same scenario packs, so role-specific artifacts are included automatically wherever those packs are instantiated.

## Instances

Dataset size controls deterministic scenario instances:

- Small: 11 instances total.
- Medium: 88 instances total.
- Large: 440 instances total.

Each instance has a scenario pack ID and distinct scenario instance ID.

Generating a dataset creates instances for every scenario pack in one operation. Operators do not need to
select a scenario pack to "send" it to Workforce One; the selected pack in `/console` is only a lens for
inspection and targeted mutation. Use the console's All Scenario Flow action to verify pack coverage,
connection-visible change counts, and continuous-clock status without exposing raw payloads or secrets.

Instances, not packs, hold runtime state: seed, dataset size, started time, current time, pause state, event occurrence times, triggered event IDs, event log, completion state, concrete participants, and account/product/project/service/workstream context. Instance APIs mutate only the selected instance.

When an operator manually triggers an event, that event occurs at the instance's current simulation time. It does not wait for the template's scheduled `atHour`, and no other instance from the same pack is affected.

## Realtime Continuous Mode

Realtime reconciliation never inserts manual event IDs and never assigns occurrence times to untriggered manual events. Manual events occur only through the explicit trigger API, remain idempotent, and keep the selected instance's current simulation time as the occurrence time.

Continuous mode determines lifecycle completion from scheduled nonmanual events plus their delayed visible/update/delete horizons. Completed instances become eligible for successors after their persisted successor due time; due successors are created in deterministic bounded batches.

Continuous mode reuses these same 11 packs. It does not add hidden Workforce One-specific scenario logic.

Scenario authoring rules live in `docs/SCENARIO_AUTHORING.md`.
