# Personas and Permissions

## Role Templates

The simulator keeps the original 12 persona categories as role templates:

- Product IC
- Product Manager
- Product Director
- VP Product
- Engineering IC
- Engineering Manager
- Engineering Director
- VP Engineering
- Customer Success IC / CSM
- Customer Success Manager
- Customer Success Director
- VP Customer Success

These templates are not the generated user limit. A generated organization can contain dozens or hundreds of people occupying these templates.

## Departments

- Product
- Engineering
- Customer Success

## Role Levels

- IC
- Manager
- Director
- VP

## Permission Model

Every generated person receives source identities, permission groups, work ownership, and a person-level connection. The feed filters by:

- allowed source systems
- allowed groups
- explicit user ACLs
- tenant boundary

The same fictional company is shared. People see different slices of one world, not separate universes.

## Reporting Is Not Permission

A manager may have direct reports, but that does not automatically grant access to every source object visible to those reports. Director and VP visibility must come from source groups, meetings, summaries, escalations, shared channels, or explicit portfolio access.

## Connection IDs

Every person receives a connection ID in the form `conn-{personId}`. The simulator also exposes stable role-template aliases such as:

- `conn-product-ic`
- `conn-product-manager`
- `conn-product-director`
- `conn-product-vp`
- `conn-engineering-ic`
- `conn-engineering-manager`
- `conn-engineering-director`
- `conn-engineering-vp`
- `conn-customer-success-ic`
- `conn-customer-success-manager`
- `conn-customer-success-director`
- `conn-customer-success-vp`
