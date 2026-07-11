# Start Here

This repository is a separate source simulator for Workforce One ingestion testing. It is not the Workforce One product and must never become a hidden product dependency.

## New Session Checklist

1. Read this file.
2. Read `ACTIVE_WORK.md` for the current branch, baseline, verification, and limitations.
3. Read `docs/MILESTONES.md` before changing scope.
4. Read `docs/ARCHITECTURE.md`, `docs/CHANGE_LEDGER.md`, and `docs/CONTRACT.md` before changing feed, cursor, storage, or source-change behavior.
5. Read `docs/SOURCE_ADAPTERS.md` and `docs/SCENARIOS.md` before changing provider payloads or scenario packs.
6. Read `docs/ORGANIZATION.md` and `docs/PERSONAS_AND_PERMISSIONS.md` before changing generated people, reporting lines, teams, or visibility.
7. Run `pnpm install --frozen-lockfile` and `pnpm run verify` before declaring the PR ready.
8. Keep one draft PR per milestone. Do not auto-merge.

## Hard Boundaries

- Do not import from `workforce-one-platform-real`.
- Do not write to the Workforce One database.
- Do not request Workforce One secrets.
- Do not generate Workforce One Signals, Forces, Objectives, Priorities, Recommendations, AI answers, or Outcomes.
- Do not use real people, customer, email, credential, or company data.
- Do not combine milestone PRs.
- Do not begin Milestone 3 work from the Milestone 2 branch.
- Keep reporting hierarchy and permission visibility as separate models.

## Current Branch

Milestone 2 lives on `milestone-2/scenarios-and-sources`.

## Milestone 2 Review Target

Milestone 2 should prove:

1. All 12 source systems have modular adapters.
2. All 10 scenario packs exist.
3. Product, Engineering, and Customer Success are covered.
4. IC, Manager, Director, and VP source behavior is represented.
5. Multiple actual people occupy every role level.
6. Source artifacts reference concrete fictional people.
7. Reporting, dotted-line, project, account, source membership, and permission access are distinct.
8. Source records can lag, conflict, update, archive, and delete.
9. The connector feed uses a compact v3 cursor over a deterministic change ledger.
10. Small, medium, and large datasets generate within documented source-change ranges.
11. Source deep links enforce the same connection visibility as feeds.
12. Production-like runtime behavior still fails closed until durable Postgres is proven in Milestone 3.
