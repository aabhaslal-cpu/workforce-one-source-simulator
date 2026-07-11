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
- Detailed people, organization, team, relationship, source, dataset, and visibility routes require admin auth.
- Connector feeds and `/sim/{sourceSystem}/{sourceId}` require connection auth.
- Source deep links enforce the same visibility rules as source feeds.
- Reporting hierarchy does not automatically grant record access.
- Cross-department access requires explicit source ACL/group membership.

## Production-Like Fail Closed

Preview, production, and Vercel-like runtimes reject:

- missing admin credentials
- missing or empty connection credential maps
- known development credentials
- identical admin and connection credentials
- memory storage
- SQLite storage
- injected local-storage simulators

Production Postgres remains unproven. Production-like startup fails closed until Milestone 3 provides a proven adapter.

## Data Safety

- Generated people are fictional.
- Emails use `@example.test`.
- Customers, repositories, tickets, and accounts are fictional simulator entities.
- Source URLs are simulator-owned links and contain no secrets.

## Deferred To Milestone 3

- Rate limiting.
- Structured security logging.
- Load testing.
- Production Postgres verification.
- Final deployment security review.
