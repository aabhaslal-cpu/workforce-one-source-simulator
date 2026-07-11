# Workforce One Source Simulator

A standalone source-data simulator for Workforce One ingestion testing.

The simulator behaves like an external source platform. It emits fictional, permission-scoped source records through an authenticated cursor feed. It does not import Workforce One code, write to a Workforce One database, or generate Workforce One conclusions.

## Current State

Milestone 2 is implemented on `milestone-2/scenarios-and-sources` as a draft PR.

Built:

- Strict TypeScript/Hono service.
- Deterministic organization generator for Product, Engineering, and Customer Success.
- Multiple actual people at IC, Manager, Director, and VP levels.
- Uneven spans of control, primary reporting lines, dotted-line relationships, project teams, account teams, launch membership, incident membership, source identities, permission groups, and work ownership.
- Connection-bound authentication where each credential resolves server-side to exactly one connection ID.
- Admin-gated people, organization, team, source, dataset, relationship, and visibility inspection.
- Safe public catalog metadata only.
- Modular source adapters for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude-style analytics, GitHub, PagerDuty-style incidents, Salesforce, Gainsight-style customer success, and Zendesk-style support.
- Ten scenario packs covering launch readiness, adoption lag, roadmap tradeoff, incident response, delivery slip, technical debt/staffing risk, renewal risk, implementation blocker, expansion opportunity, and major cross-functional release.
- Persisted scenario instance state. Packs are reusable templates; instances hold their own seed, dataset size, clock, pause state, event occurrence times, event log, completion state, participants, and account/project/product/service/workstream context.
- Compact v3 source feed cursor over a deterministic source-change ledger: connection ID, world revision, and `afterSequence`.
- Occurred-only durable source-change ledger. Normal time advancement appends newly reached changes without rotating world revision.
- Manual triggers occur at the selected instance's current simulation time; updates and deletions are calculated relative to that actual trigger time.
- Destructive scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore atomically reconstruct the world and rotate world revision.
- Source updates, late arrivals, corrected analytics, reschedules, archived/deleted objects, and conflicting partial evidence.
- Small, medium, and large deterministic datasets.
- SQLite local persistence for scenario instance states, legacy scenario states, organization config, world revision, source-change ledger, current source-object projection, dataset metadata, and snapshots.
- Simulator-owned source deep links at `/sim/{sourceSystem}/{sourceId}` with the same connection visibility checks as feeds.
- Internal operator console at `/console`.

Dataset counts with the current implementation:

- Small: 131 source changes, 10 scenario instances.
- Medium: 1,048 source changes, 80 scenario instances.
- Large: 5,240 source changes, 400 scenario instances.

## Quick Start

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

Local development credentials are fictional and documented:

- Admin: `x-admin-api-key: dev-admin-key`
- Connection: `x-connection-secret: dev-connection-secret:<connectionId>`

Examples:

```bash
curl http://localhost:3000/healthz
curl http://localhost:3000/v1/catalog
curl http://localhost:3000/v1/catalog/scenario-packs
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/catalog/scenario-instances
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/datasets/current
curl -H 'x-admin-api-key: dev-admin-key' http://localhost:3000/v1/admin/source-changes
curl -H 'x-connection-secret: dev-connection-secret:conn-product-manager' \
  'http://localhost:3000/v1/connections/conn-product-manager/records?limit=5'
```

Generate a larger deterministic dataset:

```bash
curl -X POST -H 'x-admin-api-key: dev-admin-key' \
  -H 'content-type: application/json' \
  -d '{"seed":"demo-seed","datasetSize":"medium"}' \
  http://localhost:3000/v1/admin/datasets/generate
```

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

At this Milestone 2 draft state, the local suite has 45 Vitest tests.

## Deployment Honesty

Local durable storage is SQLite. Preview, production, and Vercel-like runtimes reject missing credentials, known development credentials, identical admin/connection credentials, memory storage, SQLite storage, and injected local-storage simulators.

A production Postgres adapter is not yet proven. Production-like startup fails closed and this repository must not be described as durable deployment-ready until Milestone 3 proves that adapter.

## Documentation Map

- `START_HERE.md`: new-session checklist and hard boundaries.
- `ACTIVE_WORK.md`: current branch, baseline, implementation status, verification, and limitations.
- `docs/MILESTONES.md`: exactly three milestones.
- `docs/ARCHITECTURE.md`: engine, ledger, storage, adapter, and API architecture.
- `docs/CHANGE_LEDGER.md`: v3 cursor and world-revision behavior.
- `docs/SOURCE_ADAPTERS.md`: adapter responsibilities and coverage.
- `docs/SCENARIOS.md`: 10 scenario packs.
- `docs/DATASET_GENERATION.md`: small/medium/large behavior.
- `docs/ORGANIZATION.md`: organization graph and relationships.
- `docs/SECURITY.md`: auth, catalog exposure, permissions, and fail-closed rules.
- `docs/CONTRACT.md` and `openapi/source-simulator.v1.yaml`: external contract.
- `docs/DEPLOYMENT.md`: local operation and production limitations.
- `docs/WORKFORCE_ONE_INTEGRATION.md`: integration boundary.

## Non-Goals

The simulator does not build Workforce One UI, AI reasoning, recommendations, priorities, Signals, Forces, Objectives, Outcomes, real OAuth integrations, public demos, load tests, or a direct Workforce One database importer.
