# Source Systems

Milestone 2 implements modular adapters under `src/adapters/`.

| Source       | Adapter           | Simplified Behavior                                                                               |
| ------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| Slack        | `slack.ts`        | Events API message events, thread timestamps, edits, reactions, and message_deleted events        |
| Gmail        | `gmail.ts`        | Message and Thread resources, headers, labelIds, late email, and TRASH label representation       |
| Calendar     | `calendar.ts`     | meetings, recurring flags, organizers, attendees, agendas, reschedules, cancellations             |
| Notion       | `notion.ts`       | pages, databases, owners, editors, restricted pages, updates, archived pages                      |
| Jira         | `jira.ts`         | epics/stories/tasks/bugs, assignee/reporter, status, priority, sprint, dependencies, changelog    |
| Productboard | `productboard.ts` | features, insights, product areas, customer feedback, roadmap position, archived features         |
| Amplitude    | `amplitude.ts`    | metric snapshots, adoption, cohorts, delayed and corrected metrics                                |
| GitHub       | `github.ts`       | REST issue and pull request resources with users, reviewers, refs, merge and close state          |
| PagerDuty    | `pagerduty.ts`    | incidents, severity, responders, acknowledgement, reassignment, escalation, resolution            |
| Salesforce   | `salesforce.ts`   | accounts, opportunities, owners, amounts, stages, close dates, procurement delay                  |
| Gainsight    | `gainsight.ts`    | CTA, SuccessPlan, and ScorecardMeasure-style objects with custom-field extensions                 |
| Zendesk      | `zendesk.ts`      | ticket objects with requester, submitter, assignee, priority, status, comments, and custom_fields |

Adapters validate provider payload shape, build simulator-owned deep links, and produce create/update/delete drafts. They are intentionally not full vendor API clones.

All emitted source records reference concrete generated people through provider-native fields where that source would normally expose people. The simulator's own `actorRef`, ACLs, and scenario correlation remain in the outer source record, not inside `rawPayload`.
