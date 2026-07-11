# Workforce One Source Simulator

A standalone, production-like source data simulator for Workforce One ingestion testing.

This repository intentionally does not import from, write to, or depend on the Workforce One product repository. It behaves like an external source platform that exposes authenticated, permission-scoped, cursor-paginated source records through a documented HTTP contract.

## Current State

Milestone 1 is implemented on `milestone-1/core-simulator-platform` as a hardened draft foundation:

- Strict TypeScript Node service using Hono.
- Deterministic simulation engine with injected seed and simulation clock.
- Configurable organization generator with multiple actual people per role level.
- Cycle-free reporting hierarchy, teams, manager/direct-report relationships, work ownership, and permission memberships.
- One fictional tenant with Product, Engineering, and Customer Success departments.
- The 12 persona categories are role templates, not the limit of generated users.
- Connection-bound authentication: each credential resolves server-side to exactly one connection ID.
- Admin-gated organization, people, team, source identity, assignment, and visibility inspection routes.
- Safe unauthenticated catalog metadata only.
- `SourceFeedBatchV1` Zod contract, JSON Schema, OpenAPI, and examples with v2 connection-bound checkpoint cursors.
- Strict Zod request validation with bounded request body, pagination, time advancement, and organization sizes.
- Temporal source-object updates that appear only when the simulation clock reaches the update time.
- Simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}`.
- Durable local SQLite storage for scenario states, organization configuration, and snapshots.
- Fail-closed production-like startup when required credentials are unsafe or durable Postgres storage is unavailable/unproven.
- Internal operator console at `/console`, including organization tree and person visibility inspection.
- Automated tests for determinism, organization generation, pagination, permissions, auth boundaries, temporal updates, deep links, SQLite persistence, snapshots, and contract artifacts.

Milestone 2 must not begin from this PR. It expands breadth across every required source adapter, all 10 scenario packs, richer cross-functional relationships, and deeper organization-aware communication patterns. Milestone 3 completes deployment-grade verification.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development uses documented fictional credentials only:

- Admin: `x-admin-api-key: dev-admin-key`
- Connection: `x-connection-secret: dev-connection-secret:<connectionId>`

Useful endpoints:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/v1/catalog
curl -H 'x-admin-api-key: dev-admin-key' \
  http://localhost:3000/v1/catalog/organization/tree
curl -H 'x-connection-secret: dev-connection-secret:conn-product-manager' \
  'http://localhost:3000/v1/connections/conn-product-manager/records?limit=5'
curl -X POST -H 'x-admin-api-key: dev-admin-key' \
  -H 'content-type: application/json' \
  -d '{"hours":24}' \
  http://localhost:3000/v1/admin/scenarios/product-launch-readiness/advance
```

## Verification

```bash
pnpm run verify
```

## Deployment Honesty

Local durable storage is implemented through SQLite. Production, preview, and Vercel-like environments reject missing credentials, known development credentials, identical admin/connection credentials, memory storage, SQLite storage, and injected local-storage simulators. A production Postgres adapter is not yet proven in this milestone, so production-like startup fails closed and this PR must not be described as durable deployment-ready.

## Documentation Map

Start with `START_HERE.md`, then read:

- `ACTIVE_WORK.md` for the current milestone contract and handoff notes.
- `docs/MILESTONES.md` for the exact three-milestone plan.
- `docs/ORGANIZATION.md` for the organizational graph contract.
- `docs/ARCHITECTURE.md` for the system shape.
- `docs/SECURITY.md` for auth, catalog exposure, and fail-closed rules.
- `docs/CONTRACT.md` and `openapi/source-simulator.v1.yaml` for the external HTTP contract.
- `docs/DEPLOYMENT.md` for local SQLite and production limitations.
- `docs/WORKFORCE_ONE_INTEGRATION.md` for the integration boundary.

## Non-Goals

This simulator does not build Workforce One UI, AI reasoning, recommendations, priorities, Signals, Forces, Objectives, Outcomes, real OAuth integrations, or a direct Workforce One database importer.
