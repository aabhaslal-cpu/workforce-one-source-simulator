# Changelog

## 0.1.0 - Milestone 1 Draft

### Added

- Initial standalone Workforce One source simulator service.
- Deterministic simulation model with scenario reset, advance, trigger, pause, resume, inspect, snapshot, and restore.
- Configurable deterministic organization generator with multiple people per role level.
- Cycle-free reporting hierarchy, manager assignments, direct reports, teams, work ownership, source identities, and permission group memberships.
- Organization catalog APIs and admin generation/configuration APIs.
- Person-level record visibility and visibility comparison inspection.
- Permission-scoped connection feed with opaque v2 checkpoint cursors.
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
- Closed the production-like storage loophole by rejecting memory and SQLite storage, including injected storage and injected simulator instances backed by local storage.
- Replaced offset pagination with a deterministic source-change checkpoint cursor that is connection-bound and returned even when `hasMore` is false.
- Stabilized regenerated organization connection bindings with person-specific connection IDs derived from organizational stable keys.
- Added validation that rejects organization configs incompatible with enabled scenarios before replacement.
- Corrected temporal source updates so `updatedAt` and updated payload metadata appear only after the simulation clock reaches the update time.
- Added simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}` with connection visibility enforcement.
- Expanded tests across auth boundaries, production fail-closed behavior, public-route exposure, malformed payloads, organization bounds, hierarchy integrity, visibility, cross-department access, temporal updates, cursor tampering, deep links, SQLite persistence, snapshots, replay, and contract artifacts.

### Not Proven

- Production Postgres durability is not yet proven in this milestone.
- Vercel deployment must fail closed rather than claim durable readiness without a proven storage adapter.
