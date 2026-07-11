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

The cursor does not contain all consumed change IDs. It is bound to one connection and one world revision. Reusing it for another connection returns 400. Reusing it after a reset, destructive regeneration, or snapshot restore returns a clear stale-checkpoint 400.

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

Admin APIs expose scenario packs, scenario instances, source changes, source objects, source history, dataset metadata, organization relationships, and visibility comparison. These are simulator inspection surfaces and are not connector-feed fields.

## Artifacts

- Zod runtime schema: `src/contracts.ts`
- JSON Schema: `schemas/source-feed-batch.v1.json`
- OpenAPI: `openapi/source-simulator.v1.yaml`
- Examples: `examples/*.json`
