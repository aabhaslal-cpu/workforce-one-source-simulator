# Scenarios

Milestone 1 implements one scenario per department. Scenario records are authored by and assigned to concrete generated people selected from role templates. They are not authored by generic labels such as "Product Manager."

## Product Launch Readiness

A launch date is approaching while requirements, customer commitments, and engineering dependencies are not fully aligned.

Sources represented: Slack, Gmail, Notion, Jira, Productboard, Amplitude.

## Reliability Incident

A service degradation creates incident response records, engineering fix work, stakeholder updates, and postmortem notes.

Sources represented: PagerDuty, Slack, GitHub, Jira, Calendar, Notion, Gmail.

## Renewal Risk

A customer sponsor becomes unresponsive while support issues, adoption weakness, and commercial risk converge.

Sources represented: Salesforce, Gmail, Zendesk, Gainsight, Slack, Calendar.

## Organization-Aware Behavior

- IC records contain execution detail, assigned tickets, accounts, features, and working-team updates.
- Manager records coordinate teams, aggregate risk, and escalate upward.
- Director records cover multiple-team dependencies and resource tradeoffs.
- VP records cover portfolio-level decisions, executive updates, and major customer or launch risk.

The same event should produce different information at different levels. The simulator creates underlying source artifacts; it does not generate Workforce One conclusions.

## Deferred to Milestone 2

- Feature adoption lag.
- Roadmap tradeoff.
- Migration or delivery slip.
- Technical debt and staffing risk.
- Implementation blocker.
- Expansion opportunity.
- Major cross-functional product release.
- Richer manager rollups, escalations, dotted-line relationships, and cross-functional project membership.
