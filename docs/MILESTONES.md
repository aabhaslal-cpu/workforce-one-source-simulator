# Milestones

Use exactly three milestones. Smaller tasks are checklists inside these milestones, not new milestones.

## Milestone 1: Core Simulator Platform and Contract

Purpose: prove the end-to-end simulator foundation plus a real organizational graph.

Required proof:

1. Reset a scenario.
2. Advance simulation time.
3. Generate source records.
4. Retrieve records through an authenticated connection.
5. Paginate with an opaque cursor.
6. Retrieve only records authorized for that connection.
7. Reset and reproduce the same records with the same seed.
8. Generate a configurable organizational hierarchy.
9. Select an IC, Manager, Director and VP.
10. Prove each person has the correct manager, direct reports and source visibility.
11. Prove the same seed and configuration reproduce the same organization.
12. Prove connection credentials are bound to one server-side connection ID.
13. Prove detailed organization/person/team APIs require admin authentication.
14. Prove temporal source updates do not appear before their update time.
15. Prove local SQLite state persists across engine recreation.

Implemented in this draft:

- Repository scaffold.
- Strict TypeScript setup.
- Domain model.
- Deterministic clock and stable IDs.
- SourceFeedBatchV1.
- JSON Schema and OpenAPI.
- Connection-bound credential authentication.
- Production-like secret validation and fail-closed startup behavior.
- Cursor-based feed with Zod-validated cursor structure.
- Pagination with bounded page size.
- One tenant.
- Twelve role templates.
- Configurable organization generator.
- Multiple people per role level.
- Deterministic reporting hierarchy.
- Cycle-free reporting-line validation.
- Generated fictional identities under `@example.test`.
- Manager and direct-report relationships.
- Team and work ownership assignments.
- Admin-gated organization catalog APIs.
- Safe public catalog metadata.
- Organization tree in the operator console.
- Person-level source visibility inspection.
- Permission model independent from reporting hierarchy.
- Admin scenario and organization APIs with strict request validation.
- Snapshot and restore.
- Durable local SQLite storage for scenario states, organization configuration, and snapshots.
- Temporal source update gating.
- Simulator-owned source deep links.
- Minimal operator console.
- One scenario per department.
- Tests for determinism, organization generation, hierarchy validation, cursors, permissions, snapshots, auth, production fail-closed behavior, public-route exposure, temporal updates, deep links, SQLite persistence, and contract artifacts.

## Milestone 2: Complete Department, Level, Source and Scenario Coverage

Purpose: broaden from the vertical slice into the complete simulation matrix.

Deliver:

- Complete multi-person hierarchies for Product, Engineering, and Customer Success at larger configured sizes.
- Configurable and uneven spans of control across teams.
- Actual people assigned to every generated source record.
- Organization-aware communication patterns by IC, Manager, Director, and VP level.
- Manager rollups and escalations.
- Cross-functional project membership.
- Direct and dotted-line relationships.
- Person-to-person visibility comparison in the operator console.
- Tests covering reporting hierarchy, assignment, and permission propagation.
- All 10 required scenario packs.
- Full source adapter modules for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk-style support.
- Full Product, Engineering, and Customer Success coverage.
- Record edits, deletions, reschedules, late arrivals, lag, and conflicting information.
- Medium and large dataset modes.
- Improved operator inspection.
- Scenario event log and visibility inspection.
- Tests for every source and scenario.

Acceptance: the same fictional event appears differently across several source systems and organizational levels while preserving coherent chronology, reporting structure, assignments, and permissions.

## Milestone 3: Production Hardening and Workforce One Integration Readiness

Purpose: make the simulator deployable and safe for future connector consumption.

Deliver:

- Failure simulation controls.
- Auth failure behavior beyond M1's credential binding tests.
- Rate limiting behavior.
- Stale and invalid cursor behavior.
- Partial sync behavior.
- Load and performance tests.
- Safe logging and error handling.
- Proven production Postgres storage adapter and deployment verification.
- Vercel deployment configuration and runbook capture.
- CI workflow hardening.
- Health checks.
- Migration verification.
- Contract compatibility fixtures.
- Sample client.
- Example Workforce One connector request and response.
- Final security and architecture review.
- Deployment and integration runbooks.

Acceptance: a deployed endpoint can be consumed by a future Workforce One simulator connector without sharing code or databases.

## PR Workflow

- `milestone-1/core-simulator-platform`
- `milestone-2/scenarios-and-sources`
- `milestone-3/integration-hardening`

Use one draft PR per milestone. Do not auto-merge.
