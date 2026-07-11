# Organization Graph

The simulator models a real fictional organization with multiple generated people at every level.

## Generated Objects

- Person
- Role template
- Department
- Team
- Primary reporting relationship
- Dotted-line relationship
- Project membership
- Account membership
- Launch membership
- Incident responder membership
- Source identity
- Permission group membership
- Product, project, account, and workstream ownership

Emails use `@example.test`.

## Default Shape

The default organization is uneven and configurable:

- Product: 1 VP, 2 Directors, 2 Managers per Director, 3-5 ICs per Manager.
- Engineering: 1 VP, 2 Directors, 3 Managers per Director, 4-7 ICs per Manager.
- Customer Success: 1 VP, 2 Directors, 2-3 Managers per Director, 4-5 ICs per Manager.

Overrides are available through `customDirectorsPerVp`, `customManagersPerDirector`, and `customIcsPerManager`.

Organization config is validated against enabled scenario requirements before it is accepted. A config that removes all people for a role required by scenario packs is rejected with a 400 instead of being allowed to fail later during materialization.

## Relationships

Primary reporting lines are cycle-free. Every non-root person has exactly one primary manager.

Milestone 2 adds explicit cross-functional relationships:

- `team-project-aurora`
- `team-account-northstar`
- `team-account-summit`
- `team-incident-response`
- dotted-line release and account-gap relationships

These memberships add permission groups and work assignments but do not change primary managers.

## APIs

Detailed organization APIs require admin authentication:

- `GET /v1/catalog/people`
- `GET /v1/catalog/people/{personId}`
- `GET /v1/catalog/organization`
- `GET /v1/catalog/organization/tree`
- `GET /v1/catalog/teams`
- `GET /v1/catalog/teams/{teamId}`
- `GET /v1/admin/organization/relationships`
- `GET /v1/admin/organization/preview`
- `POST /v1/admin/organization/generate`
- `POST /v1/admin/organization/reset`
- `GET /v1/admin/organization/config`
- `PUT /v1/admin/organization/config`
- `GET /v1/admin/people/{personId}/records`
- `GET /v1/admin/people/{personId}/compare/{otherPersonId}`
