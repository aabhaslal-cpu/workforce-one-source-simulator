# Organization Graph

The simulator models a real organization with multiple generated people at every level. The 12 persona categories are role templates, not the maximum number of users.

## Core Rule

Reporting hierarchy and source permissions are related but separate models. A Director may manage multiple teams, but record visibility still comes from source memberships, permission groups, meetings, summaries, escalations, shared channels, and explicit portfolio access.

## Generated Objects

- Person
- RoleTemplate
- RoleLevel
- Department
- Team
- ReportingRelationship
- ManagerAssignment
- DirectReportAssignment
- ResponsibilityScope
- WorkOwnership
- AccountAssignment
- ProjectAssignment
- SourceMembership
- PermissionGroupMembership

Every generated person has:

- stable person ID
- fictional name
- fictional `@example.test` email
- department
- role title
- role level
- team
- manager ID, except organizational roots
- direct-report IDs
- source-system identities
- group memberships
- assigned projects, products, accounts, or workstreams
- permission scopes

## Default Template

The default organization uses uneven spans of control. Four ICs per manager is a default, not a hard rule. Examples include Product managers with 3 or 5 ICs and Engineering managers with 7 ICs.

```json
{
  "departments": {
    "product": { "vpCount": 1, "directorsPerVp": 2, "managersPerDirector": 2, "icsPerManager": 4 },
    "engineering": { "vpCount": 1, "directorsPerVp": 2, "managersPerDirector": 3, "icsPerManager": 5 },
    "customer_success": { "vpCount": 1, "directorsPerVp": 2, "managersPerDirector": 2, "icsPerManager": 4 }
  }
}
```

Overrides are available through `customDirectorsPerVp`, `customManagersPerDirector`, and `customIcsPerManager` maps.

## Bounds

Organization generation is validated before replacement:

- VPs per department: maximum 3.
- Directors per VP: maximum 8.
- Managers per Director: maximum 10.
- ICs per Manager: maximum 25.
- Total generated people: maximum 500.

These caps protect the operator API from accidental oversized generations. They can be revisited in a later performance/load milestone.

Organization replacement also checks compatibility with enabled Milestone 1 scenarios. Configurations that remove every generated person for a required role template return 400 instead of being accepted and failing later during scenario materialization.

## Reporting Rules

- ICs may report to Managers.
- Managers may report to Directors.
- Directors may report to VPs.
- VPs may be organizational roots.
- Every non-root person has exactly one primary manager.
- A manager may have zero or more direct reports.
- Reporting relationships must be cycle-free.
- Cross-functional project membership does not change the primary reporting line.
- Dotted-line relationships may be added separately and must not silently replace the primary manager.

## APIs

Detailed organization APIs require admin authentication because they expose source identities, assignments, reporting lines, and visibility-related metadata.

Catalog:

- `GET /v1/catalog/people`
- `GET /v1/catalog/people/{personId}`
- `GET /v1/catalog/organization`
- `GET /v1/catalog/organization/tree`
- `GET /v1/catalog/teams`
- `GET /v1/catalog/teams/{teamId}`

Admin:

- `POST /v1/admin/organization/generate`
- `POST /v1/admin/organization/reset`
- `GET /v1/admin/organization/config`
- `PUT /v1/admin/organization/config`
- `GET /v1/admin/people/{personId}/records`
- `GET /v1/admin/people/{personId}/compare/{otherPersonId}`

The public catalog exposes only safe metadata such as source systems, contract version, scenario names, role-template count, and aggregate organization counts.

Person-specific connection IDs are derived from organizational stable keys so current generated people have predictable bindings after regeneration. Role alias connections such as `conn-product-manager` remain predictable. Credential material is never returned by catalog or admin APIs.

## Operator UI

The console includes an Organization section for tree inspection, filters, search, person detail, source visibility, person-to-person visibility comparison, seed-based regeneration, and reset. It uses admin authentication for detailed organization reads.
