# Source Adapters

Adapters live under `src/adapters/`.

Each adapter:

- declares one `sourceSystem`
- lists supported object types
- builds vendor-native created, updated, and deleted payload drafts
- validates payload shape with provider-family Zod schemas
- builds simulator-owned source URLs

Scenario packs define what happened. Adapters define how that event appears in a source system.

`rawPayload` must not contain the old simulator wrapper metadata (`provider`, generic `sourceId`, generic `objectType`, generic `lifecycle`, scenario IDs, management chains, `simulator*` keys, or generic tombstone flags). Simulator metadata belongs in the outer `SourceRecord`; provider-native fields stay inside `rawPayload`.

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

The machine-readable source contract manifest is `src/source-contracts.ts`; runtime validation is `src/adapters/vendor-schemas.ts`; readable contract notes are in `docs/SOURCE_CONTRACTS.md`.

For expansion rules, see `docs/PROVIDER_ADAPTERS.md`.
