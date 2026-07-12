# Source Systems

Milestone 2 implements modular adapters under `src/adapters/`.

| Source       | Adapter           | Simplified Behavior                                                                                       |
| ------------ | ----------------- | --------------------------------------------------------------------------------------------------------- |
| Slack        | `slack.ts`        | Events API message events, thread timestamps, edits, reactions, and message_deleted events                |
| Gmail        | `gmail.ts`        | Message and Thread resources, headers, labelIds, late email, and users.messages.trash representation      |
| Calendar     | `calendar.ts`     | meetings, recurring flags, organizers, attendees, agendas, reschedules, cancellations                     |
| Notion       | `notion.ts`       | Page objects with parent, properties, owners, editors, restricted pages, updates, and archive flags       |
| Jira         | `jira.ts`         | epics/stories/tasks/bugs, assignee/reporter, status, priority, sprint, dependencies, changelog            |
| Productboard | `productboard.ts` | Entities API feature GET responses and Notes API textNote GET responses                                   |
| Amplitude    | `amplitude.ts`    | Dashboard REST active/new-user-count response subsets with delayed and corrected aggregate series         |
| GitHub       | `github.ts`       | REST issue, pull request, commit, and release resources with users, reviewers, refs, and state            |
| PagerDuty    | `pagerduty.ts`    | incidents, severity, responders, acknowledgement, reassignment, escalation, resolution                    |
| Salesforce   | `salesforce.ts`   | Account, Contact, Opportunity, Task, and Event sObject subsets with fictional owners and dates            |
| Gainsight    | `gainsight.ts`    | CTA, SuccessPlan, ScorecardMeasure, and TimelineActivity-style objects with custom-field extensions       |
| Zendesk      | `zendesk.ts`      | ticket objects with requester, submitter, assignee, priority, status, optional comment, and custom_fields |

Adapters validate provider payload shape, build simulator-owned deep links, and produce create/update/delete drafts. They are intentionally not full vendor API clones.

All emitted source records reference concrete generated people through provider-native fields where that source would normally expose people. The simulator's own `actorRef`, ACLs, and scenario correlation remain in the outer source record, not inside `rawPayload`.
