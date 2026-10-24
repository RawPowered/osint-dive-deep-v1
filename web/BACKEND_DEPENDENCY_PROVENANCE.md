# DiveDeep backend dependency provenance

Packaging revision: `2026-07-28-gcp-rc1`

## Reproducible installation

- `package-lock.json` is the installation authority for the Namecheap Node.js deployment.
- The lock was generated without installing packages and with lifecycle scripts disabled.
- Production installation should use `npm ci --omit=dev --ignore-scripts`.
- Direct dependency ranges were preserved except for `@google-cloud/run`, which was updated from 3.2.0 to the current stable 3.3.0 release.

## Verified Cloud Run client

Google's official GitHub changelog identifies `@google-cloud/run` 3.3.0 as the current release dated 2026-06-16:

https://raw.githubusercontent.com/googleapis/google-cloud-node/main/packages/google-cloud-run/CHANGELOG.md

Release commit: `b4d5da72a41c4d961eaeee7b7633c7885ecb9166`

## Current advisory gate

The 2026-07-28 production dependency audit reports seven high-severity advisory nodes and zero critical advisories. They form one upstream denial-of-service dependency chain:

`@google-cloud/run -> google-gax / gcp-metadata -> gaxios / rimraf -> glob -> minimatch -> brace-expansion`

Primary advisory:

https://github.com/advisories/GHSA-mh99-v99m-4gvg

The current published `google-gax` 5.0.8 still depends on the affected `rimraf` major, and `gcp-metadata` 8.1.4 still pins the affected `gaxios` 7.1.3. A non-forced lockfile-only `npm audit fix` could not produce a safe graph. No unverified override or forced major upgrade was applied.

This does not authorize production promotion. A controlled staging deployment may proceed only with synthetic/internal data, minimal exposure, bounded traffic, and explicit security-owner acceptance. Production remains blocked until the upstream graph is fixed or a reviewed override is validated in the real environment.

No backend packages were installed and no backend tests or application code were executed during this packaging pass.
