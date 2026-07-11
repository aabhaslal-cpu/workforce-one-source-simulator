# Workforce One Integration

## Boundary

Workforce One should consume this simulator like an external source platform.

The simulator returns source records. Workforce One derives evidence, provenance, Signals, Forces, Objectives, Priorities, Recommendations, AI answers, and Outcomes.

## Connector Flow

1. Workforce One stores a configured simulator connection and its credential.
2. The connector calls `/v1/connections/{connectionId}/manifest`.
3. The simulator resolves the credential server-side to one connection ID.
4. The simulator rejects a URL connection ID mismatch with 403.
5. The connector calls `/v1/connections/{connectionId}/records`.
6. Workforce One stores the opaque v3 `nextCursor`.
7. Later polls send the same cursor and receive only later authorized changes for the same world revision. Normal scenario time advancement and manual triggers append to the same world revision.
8. If the world revision changed because of scenario instance reset/delete, dataset generation, organization regeneration, or snapshot restore, Workforce One receives a stale-checkpoint 400 and must perform an intentional reset/reseed flow.
9. Workforce One may fetch simulator `sourceUrl` links with the same connection credential.

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

## Do Not Do

- Do not import simulator code into Workforce One.
- Do not write simulator records directly to the Workforce One database.
- Do not trust client-supplied tenant, person, role, or scope values.
- Do not use one credential for multiple simulator connections.
- Do not reason from simulator admin event logs.
- Do not treat Milestone 2 as proven production durable deployment readiness.
