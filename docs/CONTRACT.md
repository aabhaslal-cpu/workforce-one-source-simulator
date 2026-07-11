# Contract

The external feed contract is `SourceFeedBatchV1`.

```json
{
  "schemaVersion": "source-feed.v1",
  "connectionId": "conn-product-manager",
  "batchId": "batch-example",
  "generatedAt": "2026-07-10T20:00:00.000Z",
  "records": [],
  "nextCursor": "opaque-v2-checkpoint",
  "hasMore": false
}
```

## Rules

- The simulator must not send a trusted Workforce One tenant ID.
- Workforce One derives tenant from its configured connection.
- Every record has a stable source system, source ID, object type, timestamp, raw provider payload, source URL, ACL, change metadata, correlation metadata, and schema version.
- Each emitted change has `changeId`, `changeType`, `changeSequence`, and `changeOccurredAt`.
- `updatedAt` appears only after the simulation clock reaches the deterministic source-object update time.
- Updated source-object versions preserve the same `sourceSystem` and `sourceId`.
- Cursors are opaque v2 checkpoints bound to one connection and are validated server-side.
- A checkpoint represents consumed change IDs, not an offset in a dynamically sorted list.
- The API returns a checkpoint cursor even when `hasMore` is false so a later poll can continue from it.
- Re-requesting the same cursor returns the same page while scenario and organization state are unchanged.
- A cursor issued for one connection cannot be used for another connection.
- Continuing from a saved cursor after the simulation clock advances returns newly visible creates and updates without duplicates or skips.
- Page size is bounded to 100 records.
- The feed validates through Zod and the JSON Schema in `schemas/source-feed-batch.v1.json`.
- Breaking changes require a new contract version.

## Person Context

Records are authored by actual generated people. `actorRef` is a generated person ID, and raw payloads may include `actorPersonId`, `actorEmail`, `assigneePersonId`, and `assigneeEmail` for provider-shaped debugging.

## Auth

- Connection feed and source deep links: `x-connection-secret` or `Authorization: Bearer <secret>`.
- Admin controls and detailed catalog: `x-admin-api-key` or `Authorization: Bearer <admin-key>`.
- Each connection credential resolves server-side to exactly one connection ID.
- The authenticated connection ID must match the URL connection ID or the request returns 403.
- Admin credentials must never work as connection credentials.
- Admin and connection credentials must be different.
- Known development credentials are rejected outside local development.

## Source Deep Links

Every emitted `sourceUrl` points to:

```text
GET /sim/{sourceSystem}/{sourceId}
```

The endpoint returns the current fictional source object in a simulator-owned view. It requires connection authentication, returns 404 for unknown source objects, and returns 403 when the authenticated connection cannot see the object.

## Catalog Exposure

The public catalog exposes only safe high-level metadata. Detailed people, teams, source identities, assignments, organization tree, and visibility comparison require admin authentication.

## Endpoints

See `openapi/source-simulator.v1.yaml` for the source of truth.
