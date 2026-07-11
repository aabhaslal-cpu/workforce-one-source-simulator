# Provider Adapters

Provider adapters live in `src/adapters`.

Adapters shape simulator records into provider-like raw payloads. They do not call external APIs and they do not import Workforce One code.

## Rules

- Preserve stable `sourceSystem`, `sourceId`, `changeId`, `changeType`, and `changeOccurredAt`.
- Include concrete generated actor/assignee/person references where the source would naturally have them.
- Keep provider payloads fictional and deterministic.
- Represent updates/deletes through provider-shaped lifecycle fields.
- Keep ACL and permission behavior in the simulator record, not hidden inside adapter-only fields.
- Do not generate real routable emails, real customer names, real repository URLs, or real secrets.

## Adding A Provider

1. Add the source system to `sourceSystems` in `src/domain.ts`.
2. Add an adapter in `src/adapters`.
3. Register it in `src/adapters/registry.ts`.
4. Add scenario records that use the provider.
5. Update `docs/SOURCE_SYSTEMS.md`, OpenAPI/examples if needed, and tests.

The connector feed contract remains `SourceFeedBatchV1`.
