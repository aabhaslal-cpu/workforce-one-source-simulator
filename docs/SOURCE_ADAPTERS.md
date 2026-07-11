# Source Adapters

Adapters live under `src/adapters/`.

Each adapter:

- declares one `sourceSystem`
- lists supported object types
- builds created, updated, and deleted/tombstone payload drafts
- validates payload shape
- builds simulator-owned source URLs

Scenario packs define what happened. Adapters define how that event appears in a source system.

## Registry

`src/adapters/registry.ts` registers all 12 adapters:

- Slack
- Gmail
- Calendar
- Notion
- Jira
- Productboard
- Amplitude
- GitHub
- PagerDuty
- Salesforce
- Gainsight
- Zendesk

Adapters are simplified simulator-owned representations. They do not clone complete vendor APIs.

For expansion rules, see `docs/PROVIDER_ADAPTERS.md`.
