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

## Normal And Risk Activity

The scenarios include routine planning, product discovery, standups/meetings, completed milestones, support and customer updates, merged code, incidents, slips, adoption issues, renewals, expansion, and cross-functional releases.
