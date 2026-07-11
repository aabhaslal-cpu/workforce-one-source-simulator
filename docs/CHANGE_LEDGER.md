# Change Ledger

Milestone 2 replaces consumed-ID cursors with a compact v3 checkpoint over a deterministic source-change ledger.

The durable ledger is occurred-only. Scenario definitions may describe future records, updates, or deletions, but the stored ledger contains only source changes whose business event and mutation time have been reached.

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

Normal time advancement and manual triggers append new changes with increasing `ledgerSequence` values and do not rotate `worldRevision`. A saved cursor can be reused after those operations and returns only newly visible authorized changes after its `afterSequence`.

Manual triggers use the selected scenario instance's current simulation time as the business event occurrence time. Initial source changes become eligible immediately. `updatedAfterHours` and `deletedAfterHours` are calculated from the actual trigger time, not from the template's original `atHour`.

## World Revision

World revision changes on destructive scenario instance reset/delete, organization regeneration, dataset generation, and snapshot restore. Old cursors fail with a stale-checkpoint 400 after the revision changes.

Snapshot restore restores business state, creates a new world revision, rebuilds the deterministic ledger/projection, and invalidates cursors from the previous world.

## Atomicity

World replacements commit scenario instance states, organization config when applicable, world revision, source-change ledger, current source-object projection, and dataset metadata together. SQLite uses one transaction; rollback tests inject failures during replacement and assert the previous world remains intact.
