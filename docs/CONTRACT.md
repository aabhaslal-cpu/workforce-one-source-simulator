# Contract

The external feed contract is `SourceFeedBatchV1`.

```json
{
  "schemaVersion": "source-feed.v1",
  "connectionId": "conn-product-manager",
  "batchId": "batch-example",
  "generatedAt": "2026-07-10T20:00:00.000Z",
  "records": [],
  "nextCursor": null,
  "hasMore": false
}
```

## Rules

- The simulator must not send a trusted Workforce One tenant ID.
- Workforce One derives tenant from its configured connection.
- Every record has a stable source system, source ID, object type, timestamp, raw provider payload, source URL, ACL, correlation metadata, and schema version.
- Cursors are opaque to clients.
- Re-requesting the same cursor returns the same page while scenario and organization state are unchanged.
- The feed validates through Zod and the JSON Schema in `schemas/source-feed-batch.v1.json`.
- Breaking changes require a new contract version.

## Person Context

Records are authored by actual generated people. `actorRef` is a generated person ID, and raw payloads may include `actorPersonId`, `actorEmail`, `assigneePersonId`, and `assigneeEmail` for provider-shaped debugging.

## Auth

- Connection feed: `x-connection-secret` or `Authorization: Bearer <secret>`.
- Admin controls: `x-admin-api-key` or `Authorization: Bearer <admin-key>`.
- Admin and connection credentials must be different in production.

## Endpoints

See `openapi/source-simulator.v1.yaml` for the source of truth.
