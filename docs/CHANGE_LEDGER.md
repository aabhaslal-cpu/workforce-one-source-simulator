# Change Ledger

Milestone 2 replaces consumed-ID cursors with a compact v3 checkpoint over a deterministic source-change ledger.

## Ledger Entry

Each source change stores:

- `ledgerSequence`
- `worldRevision`
- `changeId`
- `changeType`
- `sourceSystem`
- `sourceId`
- `changeOccurredAt`
- `sourceOccurredAt`
- `scenarioId`
- `scenarioPackId`
- `scenarioInstanceId`
- `businessEventId`
- `templateId`
- `record`
- `permissionScope`

`created`, `updated`, and `deleted` changes preserve stable source identity.

## Cursor

Cursor payload:

```json
{
  "v": 3,
  "connectionId": "conn-product-manager",
  "worldRevision": "world-...",
  "afterSequence": 1452
}
```

The cursor is connection-bound, world-bound, retry-safe, and compact regardless of total change count.

## World Revision

World revision changes on destructive reset, organization regeneration, dataset generation, and snapshot restore. Old cursors fail with a stale-checkpoint 400 after the revision changes.

Snapshot restore restores business state, creates a new world revision, rebuilds the deterministic ledger/projection, and invalidates cursors from the previous world.
