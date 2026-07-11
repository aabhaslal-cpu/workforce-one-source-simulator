# Workforce One Integration

## Boundary

Workforce One should consume this simulator like an external source platform.

The simulator returns source records. Workforce One derives evidence, provenance, Signals, Forces, Objectives, Priorities, Recommendations, AI answers, and Outcomes.

No Workforce One code was changed for this simulator milestone. No Workforce One branch, commit, pull request, issue, connector, scheduler, cursor persistence, persona bootstrap, authentication change, permission change, or database access is included here. Future Workforce One integration remains out of scope.

## Connector Flow

1. Workforce One stores a configured simulator connection and its credential.
2. The connector calls `/v1/connections/{connectionId}/manifest`.
3. The simulator resolves the credential server-side to one connection ID.
4. The simulator rejects a URL connection ID mismatch with 403.
5. The connector calls `/v1/connections/{connectionId}/records`.
6. Workforce One stores the opaque v3 `nextCursor`.
7. Later polls send the same cursor and receive only later authorized changes for the same world revision. Normal scenario time advancement, manual triggers, and realtime clock reconciliation append to the same world revision.
8. If the world revision changed because of scenario instance reset/delete, dataset generation, organization regeneration, or snapshot restore, Workforce One receives a stale-checkpoint 400 and must perform an intentional reset/reseed flow.
9. Workforce One may fetch simulator `sourceUrl` links with the same connection credential.
10. Connector teams can run `/v1/admin/connector-test-kit/run` as the reference lifecycle test before integrating with Workforce One ingestion code.

## Cursor

The cursor is not an offset and does not contain consumed change IDs. It is a compact checkpoint over the source-change ledger:

```json
{
  "v": 3,
  "connectionId": "conn-product-manager",
  "worldRevision": "world-...",
  "afterSequence": 1452
}
```

The source-change ledger contains occurred changes only. Workforce One should not depend on admin/debug routes for future planned events.

Manual trigger source changes are timestamped from the scenario instance's current simulation time. Connector consumers should treat them like any other occurred source change and continue from the returned cursor.

In realtime mode, polling `/records` may reconcile the simulator clock before reading the ledger. Consumers should persist `nextCursor`, respect `hasMore`, retry safely on `429` with `Retry-After`, treat duplicate delivery idempotently by stable source identity/change ID, and reacquire a fresh cursor after stale-world responses.

## Role Alias Connections

The simulator preserves role-alias connections for:

- Product IC, Manager, Director, VP
- Engineering IC, Manager, Director, VP
- Customer Success IC, Manager, Director, VP

Generated person-specific connections also exist. Different connections see different records because of ACLs and permission groups, not because separate worlds are generated.

## Example Poll

```bash
curl -H "x-connection-secret: $SIMULATOR_CONNECTION_SECRET" \
  "$SIMULATOR_BASE_URL/v1/connections/conn-product-manager/manifest"

curl -H "x-connection-secret: $SIMULATOR_CONNECTION_SECRET" \
  "$SIMULATOR_BASE_URL/v1/connections/conn-product-manager/records?limit=100"
```

TypeScript consumers should model the returned feed as:

```ts
interface SourceFeedBatchV1 {
  schemaVersion: "source-feed.v1";
  cursorVersion: 3;
  worldRevision: string;
  connectionId: string;
  records: SourceRecord[];
  nextCursor: string;
  hasMore: boolean;
}
```

## Failure Testing

Use admin failure-mode APIs to test connector retry, backoff, stale cursor, malformed payload, duplicate, late-arrival, permission-change, and outage handling. Failure modes are deterministic and scoped; do not model them as random provider behavior.

The connector test kit demonstrates:

- initial sync
- incremental sync
- late arrivals
- updates and deletes
- destructive world reset
- stale cursor rejection
- new cursor acquisition
- permission differences
- connection regeneration behavior

## Operations

Workforce One integration environments should poll `/healthz` for liveness and `/readyz` for deployment readiness and use admin metrics/request inspection during connector development. Production Workforce One code should consume only manifest, records, and simulator-owned source deep links.

## Do Not Do

- Do not import simulator code into Workforce One.
- Do not read the simulator database directly from Workforce One.
- Do not write simulator records directly to the Workforce One database.
- Do not trust client-supplied tenant, person, role, or scope values.
- Do not use one credential for multiple simulator connections.
- Do not reason from simulator admin event logs.
- Do not treat failure-mode mutated payloads as durable source truth.
