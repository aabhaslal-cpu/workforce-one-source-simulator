# Scenario Authoring

Scenario packs are templates. They must not hold runtime state.

When adding or editing a pack:

- use fictional data only
- use `@example.test` identities through generated people
- assign concrete generated people through role templates
- keep source records provider-shaped but simulator-owned
- model future business events in `src/data.ts`
- let scenario instances hold runtime seed, clock, event occurrence times, event log, participants, and context
- do not write Workforce One conclusions into source records
- keep role-specific work artifacts source-native and role-private; examples include PM release-readiness emails or tasks, CSM escalation/QBR follow-ups, engineering readiness reviews, and safe workbook references
- use existing adapters, ACLs, and connection feeds for role-specific artifacts; do not add simulator-only side channels or synthetic Workforce One insight records

## Event Timing

Automatic events occur at `startedAt + atHour`.

Manual events occur at the selected scenario instance's `currentTime` when triggered. That occurrence time is persisted and controls created, updated, and deleted source timestamps.

Do not infer a triggered event's occurrence from its original `atHour` after it has been triggered.

## Source Updates And Deletes

Use `updatedAfterHours` and `deletedAfterHours` on record templates to model provider changes.

The durable ledger must contain only occurred changes. Future planned changes must remain in scenario definitions until the instance clock or manual trigger reaches them.

## Continuous Activity

Continuous activity reuses existing packs as templates for successor instances. Do not add a new pack solely to make realtime mode busy. The orchestrator must remain deterministic and must preserve one shared company world.

## Visibility

Reporting hierarchy and permissions are separate. Do not grant senior leaders every subordinate record by default.

Visibility must come from source ACLs, users, groups, explicit memberships, meetings, summaries, escalations, shared channels, or portfolio access.
