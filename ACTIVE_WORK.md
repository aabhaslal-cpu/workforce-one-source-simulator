# Active Work

## Current Milestone

Milestone 1: Core Simulator Platform, Contract, and Organization Graph.

## Status

Draft PR #1 is under Milestone 1 hardening review. Do not begin Milestone 2 from this branch.

Draft PR: https://github.com/aabhaslal-cpu/workforce-one-source-simulator/pull/1

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
- Connection-bound authentication where each credential resolves server-side to exactly one connection ID.
- Admin-gated detailed catalog, organization tree, teams, source identities, assignments, and visibility comparison.
- Safe unauthenticated catalog metadata only.
- Permission-aware connection feeds and manifests.
- Incremental source-change feed with opaque Zod-validated v2 checkpoint cursors and bounded page size.
- Admin scenario and organization APIs with strict Zod request validation.
- Snapshot and restore controls that preserve organization configuration.
- Durable local SQLite storage for scenario state, organization configuration, and snapshots in development/test.
- Temporal source updates represented as deterministic source-change mutations that do not appear before their update time.
- Production-like runtime storage enforcement rejects memory, SQLite, injected memory storage, and injected simulators backed by local storage.
- Organization replacement rejects configs that remove all generated people for role templates required by enabled scenarios.
- Simulator-owned deep links at `/sim/{sourceSystem}/{sourceId}`.
- Operator console organization section with tree, people filtering, person records, regeneration, and visibility comparison.
- Tests for determinism, organization generation, hierarchy validation, saved checkpoint cursors, cursor retry/tampering, permissions, snapshots, authentication, production-like storage fail-closed behavior, public-route exposure, temporal updates, source deep links, SQLite persistence, and contract artifacts.

## Milestone 1 Scenarios

- `product-launch-readiness`
- `reliability-incident`
- `renewal-risk`

## Implemented Source Families in Milestone 1

The M1 engine emits provider-shaped payloads for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk. Records are authored by actual generated people and include actor/assignee identifiers in raw payloads where applicable. Milestone 2 turns these into fuller adapter modules and completes all 10 scenario packs.

## Verification

Latest hardening verification at the time this file was refreshed:

- GitHub Actions workflow: `ci`, run `29143621866`.
- Verified head before documentation refresh: `db04571e7a0d749fb56fccd42804cd8b1077b8df`.
- Result: success.
- `pnpm run verify` completed successfully.
- TypeScript typecheck passed.
- Vitest passed 26 tests in `src/__tests__/simulator.test.ts`.
- ESLint passed.
- Build passed.

Future sessions must re-check the latest PR head status before calling the PR merge-ready.

## Known Limitations

- Local durable storage is implemented with SQLite for development/test; production Postgres storage is not yet proven.
- Production-like environments fail closed rather than silently using memory or SQLite when durable Postgres storage is unavailable/unproven.
- Failure-mode controls, rate limiting, structured logging, and load testing remain Milestone 3 work.
- Medium and large dataset expansion is deferred to Milestone 2.
- Dotted-line relationships are modeled in the type system and docs but not yet richly generated.
- The operator console is internal and intentionally simple.

## Next Starting Point

Finish Milestone 1 hardening only: keep PR #1 on the existing branch, refresh the PR body with the latest head SHA/counts/results after final CI, and decide merge readiness honestly. Milestone 2 should start only after Milestone 1 is merged and should preserve all existing contract and organization tests.
