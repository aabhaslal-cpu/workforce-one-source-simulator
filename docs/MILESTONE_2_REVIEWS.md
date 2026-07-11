# Milestone 2 Pre-Implementation Reviews

## Review 1: Product Review

### Verdict

Proceed with Milestone 2 only after preserving the Milestone 1 boundaries: the simulator emits fictional source evidence and never emits Workforce One conclusions. The required expansion is product-valid because it broadens the evidence surface across Product, Engineering, and Customer Success while keeping Workforce One responsible for deriving risks, dependencies, priorities, and outcomes.

### Scope Corrections

- Keep the operator console internal and utilitarian; do not create a public demo or Workforce One UI.
- Model source evidence, not recommendations, confidence scores, verdicts, or AI answers.
- Keep all people, companies, customers, emails, conversations, credentials, and links fictional.
- Cover all 10 scenario packs with source artifacts that are realistic enough for downstream operating-intelligence tests.
- Use compact source-change checkpoints before expanding medium and large datasets.

### Required Acceptance Criteria

- Product, Engineering, and Customer Success are represented.
- IC, Manager, Director, and VP activity is represented.
- All 10 scenario packs exist and have deterministic source artifacts.
- All 12 supported source systems are represented through modular adapters.
- Source data includes lag, disagreement, updates, archives, and deletions without telling Workforce One which source is correct.
- Generated records reference concrete fictional people and organizational relationships.

### Deferred Items

- Production Postgres, rate limiting, load testing, structured operational logging, and final deployment hardening remain Milestone 3.
- Polished UI, public demo flows, and full vendor API cloning are out of scope.

## Review 2: Architecture Review

### Verdict

Proceed after first replacing the Milestone 1 consumed-change cursor with a compact checkpoint over an append-only source-change ledger. Adapter modularization must happen before scenario expansion so business events and provider-shaped payloads do not collapse into one large data file.

### Architectural Risks

- A consumed-ID cursor would grow with medium and large datasets.
- Scenario definitions can become unmaintainable if provider payload construction is embedded directly in every event.
- Reset and snapshot restore can make old cursors ambiguous unless world revision behavior is explicit.
- Dataset-size multiplication can create duplicate identities unless sequences, source IDs, and instance IDs are deterministic.

### Required Fixes Before Coding Beyond Phase A

- Add compact v3 cursor fields: connection ID, world revision, and `afterSequence`.
- Add durable source-change ledger and current source-object projection to SQLite storage.
- Update contract docs, Zod schemas, JSON Schema, OpenAPI, and examples.
- Define snapshot restore behavior: restore business state, create a new world revision, rebuild deterministic ledger/projection, and reject old cursors.
- Add migration/runtime SQLite schema drift coverage for every durable schema change.

### Deferred Architecture

- Production-grade Postgres adapter and migration runbook remain Milestone 3.
- Load-testing and operational telemetry remain Milestone 3.

## Review 3: Security And Permission Review

### Verdict

Proceed with Milestone 2 only if Milestone 1 security boundaries remain intact. Expanded relationship modeling must not turn reporting hierarchy into implicit source access.

### Required Safeguards

- Connection credentials remain connection-bound and server-side resolved.
- Admin credentials never authenticate connector feeds.
- Public catalog exposes only safe metadata.
- Detailed organization, source, assignment, relationship, and visibility inspection remains admin-gated.
- Source ACLs apply before records or deep links are returned.
- Cross-department access requires explicit source scope, group membership, project membership, account team membership, or other modeled relationship.
- Generated payloads contain no real credentials, routable emails, real people, or real customer data.
- Deleted/tombstoned source objects must not leak payloads beyond what the provider semantics allow.

### Tests Required

- Connection-bound auth and cross-connection cursor denial.
- Public catalog exposure remains safe.
- IC, Manager, Director, and VP visibility differs by source membership and ACL.
- Cross-department access succeeds only with explicit shared membership.
- Source deep links enforce the same visibility as source feeds.
- Production-like storage fail-closed behavior remains green.

### Deferred Milestone 3 Security Work

- Rate limiting.
- Structured security logging.
- Load testing.
- Production Postgres verification.
- Final deployment security review.

## Blocker Review

No unresolved blocker remains after PR #1 merged into `main`, baseline verification passed, and the compact ledger is identified as the first implementation priority.
