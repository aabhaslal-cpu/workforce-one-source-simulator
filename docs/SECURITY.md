# Security

The simulator contains fictional data, but it models production-like boundaries.

## Implemented

- Separate admin and connection credentials.
- Server-side connection-to-seat mapping.
- No client-chosen tenant scope.
- Permission filtering before pagination output.
- No real credentials in scenario data.
- Source URLs are simulator links and contain no secrets.
- Failed auth returns generic errors.
- Contract rejects invalid feed structure in tests.

## Required Production Settings

- Set `SIMULATOR_ADMIN_API_KEY` to a strong secret.
- Set `SIMULATOR_CONNECTION_SECRET` to a different strong secret.
- Set `SIMULATOR_PUBLIC_BASE_URL` to the deployed origin.
- Do not store Workforce One secrets in this repository.

## Deferred to Milestone 3

- Rate limiting.
- Request body size limits beyond framework defaults.
- Failure-mode controls.
- Safe structured logging.
- Load testing.
- Final security review.
