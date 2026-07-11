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
- Cursor pagination with opaque Zod-validated base64url cursors and bounded page size.
- Admin scenario and organization APIs with strict Zod request validation.
- Snapshot and restore controls that preserve organization configuration.
- Durable local SQLite storage for scenario state, organization configuration, and snapshots.
- Temporal source updates represented as timeline mutations that do not appear before their update time.
- Simulator-owned deep links at `/sim/{sourceSystem}/{sourceId}`.
- Operator console organization section with tree, people filtering, person records, regeneration, and visibility comparison.
- Tests for determinism, organization generation, hierarchy validation, cursor retry/tampering, permissions, snapshots, authentication, production secret validation, public-route exposure, temporal updates, source deep links, SQLite persistence, and contract artifacts.

## Milestone 1 Scenarios

- `product-launch-readiness`
- `reliability-incident`
- `renewal-risk`

## Implemented Source Families in Milestone 1

The M1 engine emits provider-shaped payloads for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk. Records are authored by actual generated people and include actor/assignee identifiers in raw payloads where applicable. Milestone 2 turns these into fuller adapter modules and completes all 10 scenario packs.

## Verification

Latest pre-hardening baseline:

- GitHub Actions workflow: `ci`, run #6.
- Head SHA: `571a0691f647afd3950699a6ed5255802e5f7fa3`.
- Result: success.
- `pnpm run verify` completed successfully.
- Vitest passed 8 tests in `src/__tests__/simulator.test.ts`.

This hardening update expands the suite and triggers a new CI run. Future sessions must re-check the latest PR head status before calling the PR merge-ready.

## Known Limitations

- Local durable storage is implemented with SQLite; production Postgres storage is not yet proven.
- Production-like environments fail closed rather than silently using memory when durable storage is unavailable.
- Failure-mode controls, rate limiting, structured logging, and load testing remain Milestone 3 work.
- Medium and large dataset expansion is deferred to Milestone 2.
- Dotted-line relationships are modeled in the type system and docs but not yet richly generated.
- The operator console is internal and intentionally simple.

## Next Starting Point

Finish Milestone 1 hardening only: verify the new CI run, refresh PR #1 body with exact counts/results, and decide merge readiness honestly. Milestone 2 should start only after Milestone 1 is merged and should preserve all existing contract and organization tests.
