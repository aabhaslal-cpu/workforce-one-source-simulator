# Source Payload Contracts

The connector feed envelope remains `source-feed.v1`. Inside each `SourceRecord`, `rawPayload` is now validated as a vendor-native supported subset for that source system.

The machine-readable manifest lives in `src/source-contracts.ts`:

- `SOURCE_PAYLOAD_CONTRACT_VERSION`: `source-payload-contract.v2`
- retrieval date: `2026-07-11`
- official documentation URLs for each source
- provider families and required fields
- lifecycle semantics
- custom fields and limitations
- fidelity status

Runtime Zod validation lives in `src/adapters/vendor-schemas.ts`.

## Boundary

`rawPayload` must not contain simulator wrapper metadata such as generic `provider`, `sourceId`, `objectType`, `lifecycle`, top-level `actor`, top-level `assignee`, scenario IDs, management chains, `simulator*` keys, or generic tombstone flags. Simulator metadata belongs in the outer `SourceRecord` fields: `sourceSystem`, `sourceId`, `objectType`, `changeType`, `actorRef`, `acl`, and `correlation`.

Provider-native person references remain inside `rawPayload` when the vendor object naturally contains them, for example Slack `user`, Gmail headers, Calendar attendees, Jira reporter/assignee objects, GitHub reviewers, PagerDuty assignment assignees, Salesforce OwnerId, and Zendesk assignee IDs.

## Fidelity Status

| Source          | Provider API                            | Status             |
| --------------- | --------------------------------------- | ------------------ |
| Slack           | Slack Events API message event          | verified           |
| Gmail           | Gmail API v1 messages and threads       | verified           |
| Google Calendar | Calendar API v3 events                  | verified           |
| Notion          | Notion page/block/database/comment APIs | verified           |
| Jira            | Jira Cloud REST API v3 issue resource   | verified           |
| Productboard    | Productboard API v2                     | partially verified |
| Amplitude       | Dashboard REST API                      | verified           |
| GitHub          | REST API 2022-11-28                     | verified           |
| PagerDuty       | REST API incident resource              | verified           |
| Salesforce      | REST API sObject resources              | verified           |
| Gainsight       | Gainsight NXT API and Developer Docs    | partially verified |
| Zendesk         | Ticketing API tickets/comments/audits   | verified           |

Productboard and Gainsight are marked partially verified because their field sets, statuses, and object shapes are workspace or tenant configurable and some vendor pages are gated. The simulator uses a documented, deterministic supported subset and places scenario-specific extensions in vendor custom-field locations.

## Source URLs

Official reference URLs are recorded in `src/source-contracts.ts` and covered by tests so every source has at least one documentation URL and at least one declared provider family. The simulator never calls those providers; the URLs are provenance for the contract design only.
