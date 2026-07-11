# Start Here

This repository is a separate source simulator for Workforce One ingestion testing. It is not the Workforce One product and must never become a hidden product dependency.

## New Session Checklist

1. Read this file.
2. Read `ACTIVE_WORK.md` for the current branch, baseline, verification, and limitations.
3. Read `docs/MILESTONES.md` before changing scope.
4. Read `docs/ARCHITECTURE.md`, `docs/CHANGE_LEDGER.md`, and `docs/CONTRACT.md` before changing feed, cursor, storage, or source-change behavior.
5. Read `docs/PROVIDER_ADAPTERS.md`, `docs/SOURCE_ADAPTERS.md`, `docs/SCENARIOS.md`, and `docs/SCENARIO_AUTHORING.md` before changing provider payloads or scenario packs.
6. Read `docs/ORGANIZATION.md` and `docs/PERSONAS_AND_PERMISSIONS.md` before changing generated people, reporting lines, teams, or visibility.
7. Read `docs/OPERATIONS.md`, `docs/STORAGE.md`, `docs/FAILURE_MODES.md`, and `docs/TESTING.md` before changing deployment, storage, health, metrics, clock, rate limits, or failure simulation.
8. Run `pnpm install --frozen-lockfile` and `pnpm run verify` before declaring the PR ready.
9. Check GitHub Actions because CI runs Postgres integration tests, Vercel validation, route smoke, and Docker smoke.
10. Keep one draft PR per milestone. Do not auto-merge.

## Hard Boundaries

- Do not import from `workforce-one-platform-real`.
- Do not write to the Workforce One database.
- Do not request Workforce One secrets.
- Do not generate Workforce One Signals, Forces, Objectives, Priorities, Recommendations, AI answers, or Outcomes.
- Do not use real people, customer, email, credential, or company data.
- Do not combine milestone PRs.
- Do not create Milestone 4 scope. Milestone 3 is the final milestone.
- Keep reporting hierarchy and permission visibility as separate models.

## Current Branch

Milestone 3 lives on `milestone-3/production-hardening`.

## Milestone 3 Review Target

Milestone 3 should prove:

1. Postgres implements the same storage contract as SQLite.
2. Production-like runtimes require Postgres and reject memory/SQLite.
3. World replacement is transaction-backed.
4. Health, metrics, logs, request inspection, and storage inspection are available.
5. Deterministic failure simulation is configurable and admin-gated.
6. Connector lifecycle testing covers initial sync, incremental sync, late arrivals, updates/deletes, reset, stale cursor, new cursor, permission differences, and connection regeneration.
7. Benchmarks document small, medium, and large performance.
8. A persisted company clock supports manual and realtime modes, Vercel-safe catch-up, feed-triggered reconciliation, cron ticks, and deterministic continuous successor activity.
9. OpenAPI, JSON Schema, migrations, examples, and docs match runtime behavior.
10. CI is green with Postgres parity, Vercel validation, route smoke, and Docker smoke tests.
