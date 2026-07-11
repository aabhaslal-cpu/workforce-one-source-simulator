# Changelog

## 0.1.0 - Milestone 1 Draft

### Added

- Initial standalone Workforce One source simulator service.
- Deterministic simulation model with scenario reset, advance, trigger, pause, resume, inspect, snapshot, and restore.
- Configurable deterministic organization generator with multiple people per role level.
- Cycle-free reporting hierarchy, manager assignments, direct reports, teams, work ownership, source identities, and permission group memberships.
- Organization catalog APIs and admin generation/configuration APIs.
- Person-level record visibility and visibility comparison inspection.
- Permission-scoped connection feed with opaque cursor pagination.
- `SourceFeedBatchV1` Zod contract, JSON Schema, OpenAPI spec, and example payloads.
- One fictional tenant, three departments, four role levels, and twelve role templates.
- Product launch readiness, reliability incident, and renewal risk scenarios.
- Admin and connection credential separation.
- Internal operator console with organization controls.
- Documentation set for architecture, organization, contract, scenarios, personas, source systems, security, deployment, integration, and milestones.
- CI workflow and automated verification suite.
