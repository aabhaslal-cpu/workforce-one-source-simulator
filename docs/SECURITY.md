# Security

The simulator contains fictional data, but it models production-like boundaries.

## Implemented

- Admin and connection credentials are separate credential classes.
- Each connection credential resolves server-side to exactly one connection ID.
- A valid credential for connection A receives 403 when used against connection B's URL.
- Admin credentials are not accepted as connection credentials.
- Unknown and revoked connection credentials fail closed.
- No client-chosen tenant, person, role, department, or permission scope is trusted.
- Permission filtering happens before pagination output.
- Detailed people, teams, organization tree, source identities, assignments, and visibility comparison require admin authentication.
- The unauthenticated catalog exposes only safe high-level metadata.
- Known local development credentials are rejected in production-like environments.
- Missing admin credentials, missing connection credentials, identical admin/connection credentials, and in-memory storage fallback are rejected in production-like environments.
- No real credentials or routable emails appear in scenario data.
- Source URLs are simulator links and contain no secrets.
- Source deep links require connection authentication and enforce source-object visibility.
- Failed auth returns generic errors.
- Request bodies, pagination, organization generation, cursor structure, snapshot operations, and time advancement are bounded and validated.

## Local Development Credentials

Local development may use the documented fictional admin key:

```text
x-admin-api-key: dev-admin-key
```

Local connection credentials are connection-bound, not universal:

```text
x-connection-secret: dev-connection-secret:<connectionId>
```

For example, `dev-connection-secret:conn-product-manager` may access only `conn-product-manager`.

## Production-Like Requirements

Preview, Vercel-like, and production runtimes must set:

- `SIMULATOR_ADMIN_API_KEY` to a strong non-development secret.
- `SIMULATOR_CONNECTION_CREDENTIALS` to a JSON object mapping each credential to the one connection ID it authenticates.
- `SIMULATOR_PUBLIC_BASE_URL` to the deployed origin.
- Durable storage. Memory storage is forbidden.

Do not set `dev-admin-key`, `dev-connection-secret`, or `dev-connection-secret:<connectionId>` in production-like environments.

## Deferred to Milestone 3

- Rate limiting.
- Safe structured logging.
- Load testing.
- Proven production Postgres adapter and runbook.
- Final security review.
