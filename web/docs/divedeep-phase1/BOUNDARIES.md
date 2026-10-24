# Phase 1 Boundaries

## Included

- Shared resource catalog
- Schema-validated metadata
- Namespaced versioned pools
- Source-set versioning
- Package-to-source-set versioning
- Resolved export manifests
- DiveDeep Source Catalog admin UIX
- Sentinel-controlled catalog actions

## Deliberately deferred

- Ephemeral worker registration and leases
- Worker VM provisioning
- Object-storage artifact uploads
- Retention scheduler and deletion verification
- Actual source-attempt event facts for OWL and EAGLE
- GHL lifecycle outbox/inbox
- Automated removal delivery

## Protected existing systems

- OWL lead routing is unchanged.
- EAGLE analytics tables and services are unchanged.
- HAWK, SONG, and PARROT are not repurposed.
- Sentinel remains the common security and audit layer.
- Existing DiveDeep evidence and case workflows remain available.
