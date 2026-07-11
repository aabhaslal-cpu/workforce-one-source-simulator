# Source Systems

Milestone 1 emits simplified provider-shaped payloads for every required source family so the contract can exercise source identity, timestamps, threading, updates, permissions, source URLs, and raw payload shape.

## Implemented in M1 Templates

- Slack
- Gmail
- Calendar
- Notion
- Jira
- Productboard
- Amplitude-style analytics
- GitHub
- PagerDuty-style incidents
- Salesforce
- Gainsight-style success records
- Zendesk-style support

## Person-Aware Payloads

Source records include concrete generated people as authors and, where applicable, assignees. Examples:

- Slack messages have an `actorPersonId` and `actorEmail`.
- Jira issues include concrete assignee metadata.
- GitHub pull requests include a concrete author and assignee.
- Salesforce and Gainsight records are tied to a generated CSM hierarchy.
- Meetings and emails carry concrete actor context.

## M2 Adapter Work

Milestone 2 should split provider shaping into adapter modules, expand source-specific behavior, and add coverage tests for each adapter.

## Non-Goal

The simulator does not clone full vendor APIs. It creates enough provider-specific behavior to test Workforce One ingestion through a documented common feed.
