# Contract

The external connector feed contract is `SourceFeedBatchV1`.

```json
{
  "schemaVersion": "source-feed.v1",
  "cursorVersion": 3,
  "worldRevision": "world-example",
  "connectionId": "conn-product-manager",
  "batchId": "batch-example",
  "generatedAt": "2026-07-10T20:00:00.000Z",
  "records": [],
  "nextCursor": "opaque-v3-checkpoint",
  "hasMore": false
}
```

## Cursor Semantics

The cursor is opaque to clients. Internally it contains:

- `v: 3`
- `connectionId`
- `worldRevision`
- `afterSequence`

The cursor does not contain all consumed change IDs. It is bound to one connection and one world revision. Reusing it for another connection returns 400.

Normal scenario instance advance and manual trigger append source changes to the same world revision, so a saved cursor continues from its `afterSequence`. Scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore are destructive world replacements; reusing an old cursor after those operations returns a clear stale-checkpoint 400.

For manually triggered events, the event occurrence time is the scenario instance's `currentTime` at trigger time. Delayed source updates and deletions are relative to that persisted occurrence time. Automatically scheduled events continue to use `startedAt + atHour`.

The server returns `nextCursor` even when `hasMore` is false so later polling can continue from the checkpoint.

## Source Records

Every record has:

- stable source system and source ID
- object type
- source occurrence time
- optional update time
- title
- simulator-owned `sourceUrl`
- source ACL
- provider-shaped `rawPayload`
- `changeId`
- `changeType`: `created`, `updated`, or `deleted`
- deterministic `changeSequence`
- change occurrence time
- correlation metadata

Records are authored by concrete generated people. Provider payloads include actor and assignee details where the source would normally expose them. Emails use `@example.test`.

## Auth

- Connector feed and source deep links use `x-connection-secret` or `Authorization: Bearer <secret>`.
- Admin controls use `x-admin-api-key` or `Authorization: Bearer <admin-key>`.
- Each connection credential resolves server-side to exactly one connection ID.
- The URL connection ID must match the authenticated connection ID or the request returns 403.
- Admin credentials are never accepted as connection credentials.

## Source Deep Links

Every emitted `sourceUrl` resolves through:

```text
GET /sim/{sourceSystem}/{sourceId}
```

The endpoint returns the current fictional source object in JSON or simple HTML. It requires connection authentication and enforces the same visibility checks as feeds.

## Admin Inspection

Admin APIs expose scenario packs, scenario instances, source changes, source objects, source history, dataset metadata, organization relationships, and visibility comparison. Scenario packs are templates. Scenario instances are persisted runtime entities and include concrete participants and context, so instance listing/detail requires admin authentication.

Operational admin APIs expose metrics, recent sanitized requests, storage health/counts, deterministic failure-mode configuration, performance benchmark runs, and the connector test kit.

## Failure And Reset Semantics

Deterministic failure modes are simulator-owned test controls. They can alter feed responses or return provider-like errors, but they do not alter the underlying durable source ledger unless the operator separately advances, triggers, resets, restores, or regenerates the world.

Destructive world operations rotate `worldRevision`. Connectors must treat stale-checkpoint 400 responses as an intentional reset boundary and acquire a fresh cursor.

## Artifacts

- Zod runtime schema: `src/contracts.ts`
- JSON Schema: `schemas/source-feed-batch.v1.json`
- OpenAPI: `openapi/source-simulator.v1.yaml`
- Examples: `examples/*.json`
