# DiveDeep Phase 1: Shared Resource Catalog

Phase 1 gives the existing API-admin control plane a stable vocabulary for sites, services, categories, topics, capabilities, source pools, source sets, and package coverage.

The implementation deliberately stops before ephemeral worker orchestration and object storage. Those later systems can now consume immutable package manifests instead of embedding website lists in DiveDeep or application code.

## Core chain

```text
Catalog resource
→ published pool version
→ published source-set version
→ published package version
→ immutable customer export manifest
```

## Ownership

- DiveDeep Admin owns source and package operations.
- OWL's current lead-routing pools remain separate.
- EAGLE can later aggregate source-attempt facts against these stable resource IDs.
- Sentinel records administrative mutations and publications.
- DiveDeep receives resolved manifests later; it does not own the catalog.
