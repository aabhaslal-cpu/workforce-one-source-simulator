# Operator Console

The operator console is available at `/console`.

It is an internal simulator control surface, not a Workforce One screen.

## Milestone 1 Organization Section

Supports:

- view organization tree
- filter people by department
- filter people by role level
- search generated people
- select a person
- view their manager
- view their direct reports
- view their team
- view their work ownership and source memberships through person detail
- inspect records visible to a person
- compare source visibility between two people
- inspect generation seed and summary
- regenerate the organization with a chosen seed
- reset to the default organization template

Detailed organization APIs now require the admin credential. The console includes an admin-key field and calls those routes with `x-admin-api-key`.

The UI distinguishes the data model in API responses:

- primary reporting line
- source-system group membership
- work ownership
- permission access

## Deep Links

Source records include simulator-owned `sourceUrl` values. Opening those links requires the corresponding connection-bound credential and returns only the current fictional source object visible to that connection.

## Deferred to Milestone 2

- richer expandable tree controls
- editable span-of-control form controls
- preview count panel before regeneration
- dotted-line and project relationship visualization
- deeper person-to-person visibility comparison

A simple tree and detail panel is sufficient. This must not become a full HR product or polished Workforce One UI.
