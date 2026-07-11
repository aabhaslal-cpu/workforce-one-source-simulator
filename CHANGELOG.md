# Changelog

## 0.2.0 - Milestone 2 Draft

### Added

- Compact v3 feed cursor over a deterministic source-change ledger.
- Independent persisted scenario instance states. Packs are templates; instances own clocks, pause state, triggered events, event logs, participants, completion state, and contextual account/product/project/service/workstream values.
- Durable SQLite tables for `scenario_instance_states`, `world_state`, `source_change_ledger`, `source_objects`, and `dataset_metadata`.
- Dataset metadata and deterministic small, medium, and large dataset generation.
- Modular source adapter registry with Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk adapters.
- Ten scenario packs covering Product, Engineering, Customer Success, and cross-functional release workflows.
- Scenario instance catalog and admin inspection routes.
- Source-object projection, source-object history, and source-change admin routes.
- Organization relationship route and explicit dotted-line relationships.
- Cross-functional project, account, launch, and incident memberships.
- Operator console controls for datasets, scenario packs/instances, source objects, source changes, and source history.
- Tests for compact cursor behavior, stale world revisions, adapter coverage, scenario-pack coverage, dataset size ranges, source history, explicit relationships, new admin APIs, and SQLite ledger/metadata persistence.
- Tests for instance independence, real POST creation, occurred-only ledger behavior, atomic SQLite rollback, snapshot restore, and migration/runtime schema drift.

### Changed

- `SourceFeedBatchV1` now includes `cursorVersion: 3` and `worldRevision`.
- Feed cursors now contain only connection ID, world revision, and `afterSequence`; they do not contain consumed change IDs.
- The durable ledger now stores only occurred source changes. Normal advance and manual trigger append new changes without rotating world revision.
- Scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore are destructive world replacements that rotate world revision.
- Source materialization now uses provider adapters to shape raw payloads.
- Source IDs include scenario instance identity so medium and large datasets do not duplicate source identities.
- Snapshot payloads now restore independent scenario instance states and reconstruct the ledger/projection instead of treating saved future source history as authoritative.
- OpenAPI, JSON Schema, examples, docs, and tests are updated to the v3 cursor contract.

### Dataset Counts

- Small: 131 source changes, 10 scenario instances.
- Medium: 1,048 source changes, 80 scenario instances.
- Large: 5,240 source changes, 400 scenario instances.

### Not Proven

- Production Postgres durability remains Milestone 3.
- Production-like runtimes still fail closed rather than using memory or SQLite.
- Provider adapters are simplified simulator-owned representations, not complete vendor API clones.

## 0.1.0 - Milestone 1 Draft

### Added

- Initial standalone Workforce One source simulator service.
- Deterministic simulation model with scenario reset, advance, trigger, pause, resume, inspect, snapshot, and restore.
- Configurable deterministic organization generator with multiple people per role level.
- Cycle-free reporting hierarchy, manager assignments, direct reports, teams, work ownership, source identities, and permission group memberships.
- Organization catalog APIs and admin generation/configuration APIs.
- Person-level record visibility and visibility comparison inspection.
- Permission-scoped connection feed with opaque checkpoint cursors.
- `SourceFeedBatchV1` Zod contract, JSON Schema, OpenAPI spec, and example payloads.
- One fictional tenant, three departments, four role levels, and twelve role templates.
- Product launch readiness, reliability incident, and renewal risk scenarios.
- Internal operator console with organization controls.
- Documentation set for architecture, organization, contract, scenarios, personas, source systems, security, deployment, integration, and milestones.
- CI workflow and automated verification suite.

### Hardened

- Replaced the universal connection secret with connection-bound credentials.
- Added server-side URL connection ID matching and 403 on credential/URL mismatch.
- Added production-like credential validation for missing, development, identical, unknown, and revoked credentials.
- Protected detailed people, teams, organization tree, source identities, assignments, and visibility comparison behind admin authentication.
- Reduced unauthenticated catalog exposure to safe high-level metadata.
- Added strict Zod request validation, malformed JSON handling, cursor validation, bounded page size, bounded body size, bounded time advancement, and bounded organization generation.
- Added durable local SQLite storage for scenario states, organization configuration, and snapshots.
- Added fail-closed production-like behavior when durable storage is unavailable instead of using process memory.
- Corrected temporal source updates so `updatedAt` and updated payload metadata appear only after the simulation clock reaches the update time.
- Added simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}` with connection visibility enforcement.
