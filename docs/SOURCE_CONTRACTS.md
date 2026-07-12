# Source Payload Contracts

The connector feed envelope remains `source-feed.v1`. Inside each `SourceRecord`, `rawPayload` is now validated as a vendor-native supported subset for that source system.

The machine-readable manifest lives in `src/source-contracts.ts`:

- `SOURCE_PAYLOAD_CONTRACT_VERSION`: `source-payload-contract.v6`
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

| Source          | Provider API                          | Status             |
| --------------- | ------------------------------------- | ------------------ |
| Slack           | Slack Events API message event        | verified           |
| Gmail           | Gmail API v1 messages and threads     | verified           |
| Google Calendar | Calendar API v3 events                | verified           |
| Notion          | Notion API pages                      | verified           |
| Jira            | Jira Cloud REST API v3 issue resource | verified           |
| Productboard    | Productboard API v2 Entities/Notes    | partially verified |
| Amplitude       | Dashboard REST active/new user counts | verified           |
| GitHub          | REST API 2022-11-28                   | verified           |
| PagerDuty       | REST API incident resource            | verified           |
| Salesforce      | REST API sObject resources            | verified           |
| Gainsight       | Gainsight NXT API and Developer Docs  | partially verified |
| Zendesk         | Ticketing API tickets                 | verified           |

Productboard and Gainsight are marked partially verified because their field sets, statuses, and object shapes are workspace or tenant configurable and some vendor pages are gated. The simulator uses a documented, deterministic supported subset and places scenario-specific extensions in vendor custom-field locations.

## Source URLs

Official reference URLs are recorded in `src/source-contracts.ts` and covered by tests so every source has at least one documentation URL and its declared provider families match adapter support, runtime schemas, and generated records. The simulator never calls those providers; the URLs are provenance for the contract design only.

Checked-in fixtures live in `fixtures/vendor-payloads/source-payload-fixtures.json`. Tests require one fixture for every canonical generated family and validate each fixture against the runtime schemas.

## Supported Families

The canonical generated families are:

- Slack: `message`
- Gmail: `message`, `thread`
- Google Calendar: `event`
- Notion: `page`
- Jira: `issue`
- Productboard: `feature`, `note`
- Amplitude: `chart_response`
- GitHub: `commit`, `issue`, `pull_request`, `release`
- PagerDuty: `incident`
- Salesforce: `Account`, `Contact`, `Event`, `Opportunity`, `Task`
- Gainsight: `CallToAction`, `ScorecardMeasure`, `SuccessPlan`, `TimelineActivity`
- Zendesk: `ticket`

Legacy scenario labels such as Gmail `email`, Calendar `meeting`, Notion `decision_log`, Jira `bug`, Productboard `insight`/`textNote`, Amplitude `metric_snapshot`, Salesforce `activity`, and Gainsight `milestone` are deliberate template aliases. They canonicalize to the provider families above and are covered by tests.

Gmail trash is modeled as an `updated` source change with the `TRASH` label because `users.messages.trash` returns a Message resource. Gmail permanent delete uses the outer `deleted` source change plus the last-known Message payload because `users.messages.delete` returns an empty response body.

Productboard `feature` records are modeled as `/v2/entities/{id}` GET responses. Productboard `note` records are modeled as `/v2/notes/{id}` GET responses with `data.type: "textNote"`. The simulator does not blend those responses with create requests or webhook envelopes.

Productboard archive is modeled as an `updated` source change with `fields.archived: true`. Productboard permanent delete uses the outer `deleted` source change plus the last-known GET-style payload because the delete endpoint returns `204 No Content`. GitHub Release deletion follows the same no-body pattern: the raw release stays a last-known release object and the outer simulator `changeType` carries deletion.

For provider delete operations that return no response body, the source-change ledger copies the preceding projected source object's `rawPayload` into the deletion entry. The delete is expressed only by the outer simulator change metadata, especially `changeType: "deleted"` and `changeOccurredAt`.
