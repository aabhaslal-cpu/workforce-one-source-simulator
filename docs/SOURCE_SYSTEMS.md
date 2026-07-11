# Source Systems

Milestone 2 implements modular adapters under `src/adapters/`.

| Source | Adapter | Simplified Behavior |
| --- | --- | --- |
| Slack | `slack.ts` | channels, private channels, threads, replies, edits, reactions, deleted tombstones, deep links |
| Gmail | `gmail.ts` | messages, threads, sender/recipient/CC, labels, late email, archived/deleted representation |
| Calendar | `calendar.ts` | meetings, recurring flags, organizers, attendees, agendas, reschedules, cancellations |
| Notion | `notion.ts` | pages, databases, owners, editors, restricted pages, updates, archived pages |
| Jira | `jira.ts` | epics/stories/tasks/bugs, assignee/reporter, status, priority, sprint, dependencies, changelog |
| Productboard | `productboard.ts` | features, insights, product areas, customer feedback, roadmap position, archived features |
| Amplitude | `amplitude.ts` | metric snapshots, adoption, cohorts, delayed and corrected metrics |
| GitHub | `github.ts` | repos, issues, pull requests, commits, reviewers, CI checks, merged/closed/deleted branch state |
| PagerDuty | `pagerduty.ts` | incidents, severity, responders, acknowledgement, reassignment, escalation, resolution |
| Salesforce | `salesforce.ts` | accounts, opportunities, owners, amounts, stages, close dates, procurement delay |
| Gainsight | `gainsight.ts` | health scores, CTAs, success plans, milestones, stale scores, closed CTAs |
| Zendesk | `zendesk.ts` | tickets, requester, assignee, severity, comments, escalation, reopen, resolution, redaction |

Adapters validate provider payload shape, build simulator-owned deep links, and produce create/update/delete drafts. They are intentionally not full vendor API clones.

All emitted source records reference concrete generated people through actor, assignee, owner, reviewer, attendee, responder, or manager-chain payload fields where that source would normally expose people.
