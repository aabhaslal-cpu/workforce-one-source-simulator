# Active Work

## Current Milestone

Milestone 1: Core Simulator Platform, Contract, and Organization Graph.

## Status

Implemented as an initial foundation and ready for draft PR review.

## What Is Built

- TypeScript service scaffold with strict compiler settings.
- Deterministic simulation engine using seeded stable identities and injected simulation clock.
- SourceFeedBatchV1 contract using Zod, JSON Schema, OpenAPI, and example payloads.
- Configurable organization generator with uneven spans of control.
- Actual generated people at IC, Manager, Director, and VP levels.
- Cycle-free primary reporting hierarchy.
- Manager and direct-report assignments.
- Teams, work ownership, source identities, permission group memberships, and person-level source connections.
- One fictional tenant: Acme Digital Operations.
- Departments: Product, Engineering, Customer Success.
- Role templates: the original 12 persona categories.
- Permission-aware connection feeds and manifests.
- Cursor pagination with opaque base64url cursors.
- Admin scenario and organization APIs.
- Snapshot and restore controls that preserve organization configuration.
- Operator console organization section with tree, people filtering, person records, regeneration, and visibility comparison.
- Tests for determinism, organization generation, hierarchy validation, cursor retry, permissions, snapshots, and authentication.

## Milestone 1 Scenarios

- `product-launch-readiness`
- `reliability-incident`
- `renewal-risk`

## Implemented Source Families in Milestone 1

The M1 engine emits provider-shaped payloads for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk. Records are authored by actual generated people and include actor/assignee identifiers in raw payloads where applicable. Milestone 2 turns these into fuller adapter modules and completes all 10 scenario packs.

## Known Limitations

- Storage is currently an in-process repository abstraction with migration documents for Postgres/SQLite readiness.
- Failure modes are documented but not yet exposed as admin controls.
- Medium and large dataset expansion is deferred to Milestone 2.
- Dotted-line relationships are modeled in the type system and docs but not yet richly generated.
- The operator console is internal and intentionally simple.

## Next Starting Point

Milestone 2 should preserve all existing contract and organization tests, then expand adapter modules, the remaining scenario packs, cross-functional project membership, manager rollups/escalations, and person-to-person visibility comparison depth.
