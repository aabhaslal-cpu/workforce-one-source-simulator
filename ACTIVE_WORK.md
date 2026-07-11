# Active Work

## Current Milestone

Milestone 2: Complete Department, Level, Source, and Scenario Coverage.

## Branch And Baseline

- Baseline main commit: `379ed22d77a94f303d7ce1e650431359faee5d90`.
- Milestone 1 PR #1: merged into `main` before this work started.
- Baseline verification before modifications: `pnpm install --frozen-lockfile` passed and `pnpm run verify` passed.
- Baseline test count: 27 Vitest tests.
- Working branch: `milestone-2/scenarios-and-sources`.

## Built In Milestone 2

- Compact v3 cursor with `connectionId`, `worldRevision`, and `afterSequence`.
- Independent persisted `ScenarioInstanceState` per scenario instance. Scenario packs are templates; runtime state lives on instances, including explicit event occurrence times.
- Durable source-change ledger, current source-object projection, world revision, and dataset metadata in SQLite storage.
- Source-change ledger contains only occurred changes. Normal advance and trigger append newly reached changes without rotating world revision.
- Manual triggers record the selected instance's current simulation time as the event occurrence time. Initial source changes appear immediately, and later updates/deletions are relative to the trigger time.
- Destructive scenario instance reset/delete, dataset generation, organization regeneration, and snapshot restore rotate world revision and atomically reconstruct scenario instance states, ledger, projection, and metadata.
- Snapshot payloads include independent scenario instance states, organization config, dataset metadata, and world revision. Restoring a snapshot restores instance states, creates a new world revision, rebuilds the deterministic ledger/projection, and invalidates old cursors.
- Modular adapters for Slack, Gmail, Calendar, Notion, Jira, Productboard, Amplitude, GitHub, PagerDuty, Salesforce, Gainsight, and Zendesk.
- Ten scenario packs:
  - `product-launch-readiness`
  - `feature-adoption-lag`
  - `roadmap-tradeoff`
  - `reliability-incident`
  - `migration-delivery-slip`
  - `technical-debt-staffing-risk`
  - `renewal-risk`
  - `implementation-blocker`
  - `expansion-opportunity`
  - `major-cross-functional-product-release`
- Deterministic scenario instances for small, medium, and large datasets.
- Source lag, Slack edits, late email, corrected Amplitude metrics, delayed Salesforce changes, reopened Zendesk tickets, GitHub/Jira ordering differences, rescheduled meetings, restricted/archived pages, and deleted/tombstoned source objects.
- Cross-functional project, account, launch, and incident memberships.
- Dotted-line relationships that do not replace primary managers.
- Admin APIs for scenario packs/instances, source objects/history, source changes, dataset generation/current/reset, and organization relationships.
- Operator console controls for scenario packs/instances, dataset metadata/generation, source objects, source changes, and source history.

## Dataset Counts

With the current deterministic implementation:

- Small: 131 source changes, 10 scenario instances.
- Medium: 1,048 source changes, 80 scenario instances.
- Large: 5,240 source changes, 400 scenario instances.

## Verification Status

Latest local verification in this working tree:

- `pnpm run typecheck`: passed.
- `pnpm run test`: passed, 48 tests.
- `pnpm run lint`: passed.
- `pnpm run build`: passed.

Run `pnpm install --frozen-lockfile` and `pnpm run verify` again before final PR reporting.

## Known Limitations

- Production Postgres storage is not implemented or proven. Production-like environments fail closed rather than using memory or SQLite.
- Provider adapters are simplified and simulator-owned. They are not complete vendor API clones.
- The operator console is intentionally internal and utilitarian.
- Rate limiting, load testing, structured operational logging, production deployment verification, and final integration hardening remain Milestone 3.

## Milestone 3 Starting Point

Start Milestone 3 only after this Milestone 2 PR is reviewed and merged. Begin with a proven production Postgres adapter, deployment verification, rate limiting, logging, load tests, and connector-consumption runbooks.
