# Workforce One Source Simulator

A standalone, production-like source data simulator for Workforce One ingestion testing.

This repository intentionally does not import from, write to, or depend on the Workforce One product repository. It behaves like an external source platform that exposes authenticated, permission-scoped, cursor-paginated source records through a documented HTTP contract.

## Current State

Milestone 1 is implemented on `milestone-1/core-simulator-platform` as a reviewable foundation:

- Strict TypeScript Node service using Hono.
- Deterministic simulation engine with injected seed and simulation clock.
- Configurable organization generator with multiple actual people per role level.
- Cycle-free reporting hierarchy, teams, manager/direct-report relationships, work ownership, and permission memberships.
- One fictional tenant with Product, Engineering, and Customer Success departments.
- The 12 persona categories are role templates, not the limit of generated users.
- Person-level source connections and permission-aware source feeds.
- `SourceFeedBatchV1` Zod contract, JSON Schema, OpenAPI, and examples.
- Admin scenario and organization controls.
- Snapshot and restore controls.
- Internal operator console at `/console`, including organization tree and person visibility inspection.
- Automated tests for determinism, organization generation, pagination, permissions, snapshots, and auth boundaries.

Milestone 2 expands breadth across every required source adapter, all 10 scenario packs, richer cross-functional relationships, and deeper organization-aware communication patterns. Milestone 3 hardens failure modes, deployment, performance, and Workforce One connector readiness.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

The development defaults are safe fictional credentials:

- Admin: `x-admin-api-key: dev-admin-key`
- Connection: `x-connection-secret: dev-connection-secret`

Useful endpoints:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/v1/catalog/organization/tree
curl http://localhost:3000/v1/catalog/people
curl -H 'x-connection-secret: dev-connection-secret' \
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

## Documentation Map

Start with `START_HERE.md`, then read:

- `ACTIVE_WORK.md` for the current milestone contract and handoff notes.
- `docs/MILESTONES.md` for the exact three-milestone plan.
- `docs/ORGANIZATION.md` for the organizational graph contract.
- `docs/ARCHITECTURE.md` for the system shape.
- `docs/CONTRACT.md` and `openapi/source-simulator.v1.yaml` for the external HTTP contract.
- `docs/WORKFORCE_ONE_INTEGRATION.md` for the integration boundary.

## Non-Goals

This simulator does not build Workforce One UI, AI reasoning, recommendations, priorities, Signals, Forces, Objectives, Outcomes, real OAuth integrations, or a direct Workforce One database importer.
