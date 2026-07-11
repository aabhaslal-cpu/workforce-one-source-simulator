# Dataset Generation

Dataset generation is deterministic from seed, dataset size, organization config, scenario pack, scenario instance, and simulation time.

## Sizes

| Size | Instances | Source Changes |
| --- | ---: | ---: |
| Small | 10 | 131 |
| Medium | 80 | 1,048 |
| Large | 400 | 5,240 |

The ranges match Milestone 2 targets:

- Small: 100-250 changes.
- Medium: 1,000-2,500 changes.
- Large: 5,000-10,000 changes.

## Instances

Each scenario pack has deterministic instances with account, product, project, service, workstream, seed, and time offset. Source IDs include scenario instance ID so instances do not collide.

Scenario packs are templates. Instances are persisted runtime entities with their own current time, pause state, triggered events, event log, completion state, participants, and context. Advancing one instance does not advance any other instance from the same pack.

The source-change ledger is occurred-only. Dataset generation creates completed instances and reconstructs the current world from changes that have occurred by each instance clock; ordinary instance advancement appends newly reached changes.

## Normal And Risk Activity

The scenarios include routine planning, product discovery, standups/meetings, completed milestones, support and customer updates, merged code, incidents, slips, adoption issues, renewals, expansion, and cross-functional releases.
