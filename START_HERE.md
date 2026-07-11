# Start Here

This repository is a separate source simulator for Workforce One ingestion testing. It is not the Workforce One product and must never become a hidden product dependency.

## New Session Checklist

1. Read this file.
2. Read `ACTIVE_WORK.md` for current milestone status.
3. Read `docs/MILESTONES.md` before changing scope.
4. Read `docs/ORGANIZATION.md` before changing generated people, reporting lines, teams, or source memberships.
5. Read `docs/CONTRACT.md` before changing the feed shape.
6. Read `docs/PERSONAS_AND_PERMISSIONS.md` before changing visibility behavior.
7. Run `pnpm run verify` before declaring a milestone ready.
8. Keep one draft PR per milestone and do not auto-merge.

## Hard Boundaries

- Do not import from `workforce-one-platform-real`.
- Do not write to the Workforce One database.
- Do not request Workforce One secrets.
- Do not generate Workforce One Signals, Forces, Objectives, Priorities, Recommendations, AI answers, or Outcomes.
- Do not use real people, customer, email, credential, or company data.
- Do not combine milestone PRs.
- Keep reporting hierarchy and permission visibility as separate models.

## Current Branch

Milestone 1 lives on `milestone-1/core-simulator-platform`.

## Review Target

Milestone 1 should prove a vertical slice:

1. Reset a scenario.
2. Advance simulation time.
3. Generate source records.
4. Retrieve them through an authenticated connection.
5. Paginate with an opaque cursor.
6. Retrieve only records authorized for that connection.
7. Reset and reproduce the same records with the same seed.
8. Generate a configurable organizational hierarchy.
9. Select an IC, Manager, Director and VP.
10. Prove each person has the correct manager, direct reports and source visibility.
11. Prove the same seed and configuration reproduce the same organization.
