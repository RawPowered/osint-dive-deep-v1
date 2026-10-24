# Phase 1 Data Model

## Metadata schemas

`platform_metadata_schemas` stores versioned schema definitions. Published versions are immutable and may be assigned to resources or pools. The implemented validator intentionally supports a constrained JSON Schema subset:

- `type`
- `required`
- `properties`
- `additionalProperties`
- `enum`
- string length and pattern limits
- array size, uniqueness, and item schemas
- numeric minimum and maximum

## Resources

`platform_resources` represents a website, platform, API, directory, endpoint, or future typed service resource. Relational columns contain stable classification fields. Flexible JSON fields contain validated or declared behavior.

`platform_resource_revisions` stores an immutable snapshot whenever a resource is created or updated.

## Pools

`platform_pools` is the stable namespaced pool identity. `platform_pool_versions` is the immutable published membership snapshot. `platform_pool_memberships` supports priority, enabled state, effective date, expiration date, and membership metadata.

Phase 1 seeds only `divedeep.source` pools. Existing `owl_service_pools` and `owl_lead_pool_rules` are unchanged.

## Source sets

`divedeep_source_sets` is the stable coverage identity. `divedeep_source_set_versions` references published pool versions and optional explicit resources through:

- `divedeep_source_set_pool_links`
- `divedeep_source_set_resource_links`

Inclusion and exclusion links are resolved when a package manifest is requested. Only active resources and currently effective memberships are returned.

## Package versions

`divedeep_package_versions` binds a package to one published source-set version and immutable requirements, execution, review, and retention policies.

New package publications affect new exports. Previously created artifacts or future jobs can remain pinned to their original package version.
