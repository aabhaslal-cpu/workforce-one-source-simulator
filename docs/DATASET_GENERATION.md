# Dataset Generation

Dataset generation is deterministic from seed, dataset size, organization config, scenario pack, scenario instance, and simulation time.

## Sizes

| Size   | Instances | Source Changes |
| ------ | --------: | -------------: |
| Small  |        11 |            159 |
| Medium |        88 |          1,272 |
| Large  |       440 |          6,360 |

The ranges match Milestone 2 targets:

- Small: 100-250 changes.
- Medium: 1,000-2,500 changes.
- Large: 5,000-10,000 changes.

## Instances

Each scenario pack has deterministic instances with account, product, project, service, workstream, seed, and time offset. Source IDs include scenario instance ID so instances do not collide.

Scenario packs are templates. Instances are persisted runtime entities with their own current time, pause state, event occurrence times, triggered events, event log, completion state, participants, and context. Advancing one instance does not advance any other instance from the same pack.

Automatically scheduled events use `startedAt + atHour`. Manual triggers use the instance `currentTime` at trigger time, and delayed updates/deletions are calculated from that persisted occurrence time.

The source-change ledger is occurred-only. Dataset generation creates completed instances and reconstructs the current world from changes that have occurred by each instance clock; ordinary instance advancement appends newly reached changes.

## Continuous Activity

Realtime continuous activity does not create a second dataset or a separate company. It reuses the same persisted organization, scenario packs, source ledger, source-object projection, and permission model.

When enabled, reconciliation may create bounded deterministic successor instances for completed instances. Successor instance IDs, seeds, start times, due times, and account/product/project/service/workstream context are derived from persisted orchestration state. Repeating reconciliation for the same wall time does not duplicate successors or ledger rows.

Manual events remain manual in continuous mode. Lifecycle completion is based on scheduled nonmanual events and their delayed visible/update/delete horizons, so background successor generation does not depend on silently triggering manual story beats.

The regular workday pack adds routine operating rhythm data without replacing the generated organization, people, connections, or permission model. The major cross-functional release pack remains the broadest cross-functional storyline and spans Product, Engineering, Customer Success, all four role levels, and the source systems used by its scheduled and manually triggered events.

The benchmark harness creates one additional manual-trigger instance while measuring each dataset size, so benchmark count rows show 12, 89, and 441 instances.

## Normal And Risk Activity

The scenarios include routine planning, product discovery, standups/meetings, completed milestones, support and customer updates, merged code, incidents, slips, adoption issues, renewals, expansion, and cross-functional releases.
