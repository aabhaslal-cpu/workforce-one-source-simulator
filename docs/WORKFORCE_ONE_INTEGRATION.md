# Workforce One Integration

## Boundary

Workforce One should consume this simulator exactly like an external source platform.

The simulator returns source records. Workforce One derives evidence, provenance, Signals, Forces, Objectives, Priorities, Recommendations, and Outcomes.

## Connector Flow

1. Workforce One stores a configured simulator connection and the credential assigned to that exact connection ID.
2. The connector calls `/v1/connections/{connectionId}/manifest` with the connection-bound credential.
3. The simulator resolves the credential server-side to one connection ID and rejects mismatched URL connection IDs with 403.
4. The connector calls `/v1/connections/{connectionId}/records` with the same connection-bound credential.
5. Workforce One stores the returned opaque `nextCursor` checkpoint and uses it on later polls.
6. Workforce One maps the returned source ACL, raw payload, change metadata, and source URL into normal connector-ingress.
7. Workforce One may fetch `sourceUrl` for a readable simulator-owned source view using the same connection credential.
8. Workforce One owns all downstream interpretation.

The cursor is not an offset. It is a connection-bound checkpoint over consumed source changes, so polling from an earlier checkpoint after simulation time advances returns only newly visible creates and updates without duplicate or skipped changes.

## Example Request

```bash
curl -H 'x-connection-secret: dev-connection-secret:conn-engineering-manager' \
  'https://simulator.example.com/v1/connections/conn-engineering-manager/records?limit=25'
```

Production credentials must not use the `dev-connection-secret:<connectionId>` form.

## Do Not Do

- Do not import simulator packages into Workforce One.
- Do not write simulator records directly to the Workforce One database.
- Do not trust a tenant ID, person ID, role, or scope supplied by a client request.
- Do not use one credential for multiple simulator connections.
- Do not reason from simulator debug event logs.
- Do not treat this milestone as proven production durable deployment readiness.
