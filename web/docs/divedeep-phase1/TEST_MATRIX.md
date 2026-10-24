# Phase 1 Test Matrix

The build uses narrow tests aligned to the Phase 1 changes.

## Completed in the build environment

- JavaScript syntax checks for the server, DiveDeep admin router, catalog services, customer export service, admin bundle, and test files.
- Static schema-contract test for all Phase 1 tables and seeded pool/source-set/package structures.
- Validation tests for the supported JSON Schema subset.
- Mocked package-manifest resolution test verifying published versions, active resources, effective membership windows, and include/exclude handling.
- DiveDeep UI asset and Source Catalog contract test.
- Admin HTML duplicate-ID check.
- Phase 1 SQL seed JSON validation.
- Phase 1 SQL seed column/value count validation.
- ZIP integrity and checksum verification during packaging.

## Not performed in the build environment

- Live MySQL initialization. The release is a fresh-install baseline and no database server was available here.
- Full Express route execution because the package registry returned HTTP 503 while dependencies were being retrieved.
- External website, DuckDuckGo, search-engine, CRM, Stripe, Meta, or DiveDeep calls. Phase 1 does not require them and no credentials or live endpoints were available.

After `npm ci` on the deployment host, run:

```bash
npm run phase1:verify
```
