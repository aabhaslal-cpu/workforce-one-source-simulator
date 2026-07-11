# Security

The simulator contains fictional data, but it preserves production-like boundaries.

## Auth

- Admin and connection credentials are separate classes.
- Each connection credential resolves server-side to exactly one connection ID.
- A credential for connection A receives 403 when used against connection B's URL.
- Admin credentials are not accepted as connection credentials.
- Unknown and revoked connection credentials fail closed.
- Credential material is never emitted through public or admin APIs.

## Authorization

- Public catalog routes expose safe metadata only.
- Detailed people, organization, team, scenario instance, relationship, source, dataset, and visibility routes require admin auth.
- Connector feeds and `/sim/{sourceSystem}/{sourceId}` require connection auth.
- Source deep links enforce the same visibility rules as source feeds.
- Reporting hierarchy does not automatically grant record access.
- Cross-department access requires explicit source ACL/group membership.
- Scenario instance participants and runtime context are admin inspection data, not public catalog data.

## Production-Like Fail Closed

Preview, production, and Vercel-like runtimes reject:

- missing admin credentials
- missing or empty connection credential maps
- known development credentials
- identical admin and connection credentials
- memory storage
- SQLite storage
- injected local-storage simulators

Production-like startup requires Postgres through `DATABASE_URL`. If Postgres is missing or unavailable, startup fails closed instead of falling back to memory or SQLite.

## Data Safety

- Generated people are fictional.
- Emails use `@example.test`.
- Customers, repositories, tickets, and accounts are fictional simulator entities.
- Source URLs are simulator-owned links and contain no secrets.

## Logging And Errors

- Structured request logs are sanitized and disabled locally unless `SIMULATOR_STRUCTURED_LOGS=true`.
- Logs include request ID, operation, status, duration, connection ID, cursor metadata, and world revision when available.
- Logs and error responses must not include credentials, internal stack traces, or database connection strings.
- Error responses include a safe classification and correlation ID.

## Failure Simulation Safety

- Failure modes are admin-controlled and disabled by default.
- Failure modes are deterministic and scoped by operation, connection, source system, and optional every-Nth invocation.
- Failure modes are for connector testing only; they do not bypass authentication or return otherwise unauthorized records.

## Remaining Deployment Responsibilities

- Rotate admin and connection credentials outside the simulator.
- Restrict network access to the simulator and Postgres.
- Configure external logging, alerting, backups, and retention.
- Review generated connector credentials before exposing a deployment to other services.
