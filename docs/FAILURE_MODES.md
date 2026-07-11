# Failure Modes

Failure simulation is deterministic, repeatable, configurable, and disabled by default.

## Configuration

Use:

- `GET /v1/admin/failure-modes`
- `PUT /v1/admin/failure-modes`
- `POST /v1/admin/failure-modes/reset`

Rules may target:

- `operation`
- `connectionId`
- `sourceSystem`
- `everyNth`

Example:

```json
{
  "schemaVersion": "failure-modes.v1",
  "rules": [
    {
      "id": "product-manager-rate-limit",
      "enabled": true,
      "mode": "rate_limit",
      "operation": "feed",
      "connectionId": "conn-product-manager"
    }
  ]
}
```

## Supported Modes

| Mode | Effect |
| --- | --- |
| `rate_limit` | Returns 429. |
| `timeout` | Adds deterministic latency and returns 504 by default. |
| `service_unavailable` | Returns 503. |
| `internal_error` | Returns 500. |
| `network_latency` | Adds deterministic latency without failing. |
| `partial_page` | Returns a smaller page. |
| `cursor_corruption` | Returns a deliberately invalid next cursor. |
| `auth_failure` | Returns 401 after credential binding. |
| `expired_credentials` | Returns 401 after credential binding. |
| `provider_outage` | Returns 503. |
| `malformed_payload` | Removes a safe payload field and marks the raw payload. |
| `permission_changes` | Returns an empty visible page for the scoped rule. |
| `deleted_objects` | Marks the first returned record as deleted. |
| `edited_objects` | Edits the first returned record title and marks the raw payload. |
| `late_arriving_objects` | Backdates source occurrence and marks the raw payload. |
| `duplicate_objects` | Duplicates the first returned record in the page. |
| `stale_objects` | Sets batch generated time to the first record occurrence time. |

Failure modes never grant unauthorized record visibility and never expose credentials.
