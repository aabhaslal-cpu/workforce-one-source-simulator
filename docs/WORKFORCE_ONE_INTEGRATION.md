# Workforce One Integration

## Boundary

Workforce One should consume this simulator exactly like an external source platform.

The simulator returns source records. Workforce One derives evidence, provenance, Signals, Forces, Objectives, Priorities, Recommendations, and Outcomes.

## Connector Flow

1. Workforce One stores a configured simulator connection.
2. The connector calls `/v1/connections/{connectionId}/manifest` to inspect source and seat scope.
3. The connector calls `/v1/connections/{connectionId}/records` with its connection secret.
4. Workforce One maps the returned source ACL and raw payload into normal connector-ingress.
5. Workforce One owns all downstream interpretation.

## Example Request

```bash
curl -H 'x-connection-secret: dev-connection-secret' \
  'https://simulator.example.com/v1/connections/conn-engineering-manager/records?limit=25'
```

## Do Not Do

- Do not import simulator packages into Workforce One.
- Do not write simulator records directly to the Workforce One database.
- Do not trust a tenant ID from simulator payloads.
- Do not reason from simulator debug event logs.
