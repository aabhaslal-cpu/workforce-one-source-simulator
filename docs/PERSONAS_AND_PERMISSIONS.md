# Personas And Permissions

## Role Templates

The 12 persona categories are role templates, not generated-user limits:

- Product IC, Manager, Director, VP
- Engineering IC, Manager, Director, VP
- Customer Success IC/CSM, Manager, Director, VP

Generated organizations contain multiple actual fictional people occupying these templates.

## Visibility Model

The feed filters by:

- authenticated connection ID
- allowed source systems
- source ACL groups
- explicit user ACLs
- tenant boundary

Clients cannot supply trusted tenant, role, department, person, or permission scope.

## Reporting Is Not Permission

Primary manager relationships do not automatically grant access to direct-report records. Visibility comes from modeled source memberships, project teams, account teams, launch rooms, incident groups, leadership groups, or explicit ACL users.

Dotted-line relationships are separate relationship records and never replace the primary manager silently.

## Connection IDs

Every generated person receives a person-specific connection ID derived from their stable organizational key. Stable role aliases also exist, such as `conn-product-manager` and `conn-engineering-vp`.

Credential material is never returned by public or admin APIs.
