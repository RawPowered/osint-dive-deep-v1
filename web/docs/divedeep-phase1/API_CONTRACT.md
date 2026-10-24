# Phase 1 Admin API Contract

All endpoints live inside the existing authenticated API-admin router. Read access requires an administrative session. Mutations require root role and the existing admin CSRF token. Request/response bodies remain omitted from broad Sentinel forensic-body capture.

## Read

- `GET /api/divedeep/catalog`
- `GET /api/divedeep/catalog/resources/:resourceId/revisions`
- `GET /api/divedeep/packages/:packageId/source-manifest?version=N`

## Metadata schemas

- `POST /api/divedeep/catalog/schemas`
- `PATCH /api/divedeep/catalog/schemas/:schemaId`

## Resources

- `POST /api/divedeep/catalog/resources`
- `PATCH /api/divedeep/catalog/resources/:resourceId`

## Pools

- `POST /api/divedeep/catalog/pools`
- `POST /api/divedeep/catalog/pools/:poolId/versions`
- `PUT /api/divedeep/catalog/pool-versions/:versionId/members`
- `POST /api/divedeep/catalog/pool-versions/:versionId/publish`

## Source sets

- `POST /api/divedeep/catalog/source-sets`
- `POST /api/divedeep/catalog/source-sets/:sourceSetId/versions`
- `PUT /api/divedeep/catalog/source-set-versions/:versionId/links`
- `POST /api/divedeep/catalog/source-set-versions/:versionId/publish`

## Package coverage

- `POST /api/divedeep/catalog/packages/:packageId/versions`
- `POST /api/divedeep/catalog/package-versions/:versionId/publish`

Published schema, pool, source-set, and package versions are immutable. Changes require a new version.

## Draft version updates

- `PATCH /api/divedeep/catalog/pool-versions/:versionId` updates draft labels, descriptions, selector rules, metadata, and optionally resolved members.
- `PATCH /api/divedeep/catalog/source-set-versions/:versionId` updates draft selection mode, metadata, and optionally linked pools/resources.
- Published versions reject mutation and require a new version.
