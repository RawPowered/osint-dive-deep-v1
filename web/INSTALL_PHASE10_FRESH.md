# DiveDeep v1.16.0 Phase 10 Fresh Installation

This package is a complete fresh-install backend. It includes the full schema through version 64, every prior DiveDeep phase retained in the release, production environment profiles, rollout controls, rehearsal tooling, and deployment runbooks.

## 1. Provision isolated environments

Create separate development, staging, and production resources. Do not share databases, buckets, deployment identities, secrets, OAuth clients, GHL webhook secrets, or Cloud Run jobs across environments.

The files under `deploy/environments/` are overlays. Start from `.env.example`, then apply the values for the selected environment.

## 2. Install runtime dependencies

```bash
npm install --omit=dev
```

When no lock file is used by the deployment system, install from `package.json` in a controlled build environment and retain the resolved dependency inventory with the release artifact.

Required runtime:

- Node.js 20 or newer
- MySQL 8.0 or newer
- Private S3-compatible object storage
- HTTPS termination

## 3. Configure environment identity

Production requires at minimum:

```dotenv
NODE_ENV=production
DEPLOYMENT_ENV=production
DIVEDEEP_DEPLOYMENT_ID=divedeep-prod-primary
DIVEDEEP_STORAGE_NAMESPACE=divedeep-prod-primary
DIVEDEEP_PRIMARY_COMPUTE_PROVIDER=google_cloud_run_jobs
DIVEDEEP_PRODUCTION_ACK=DIVEDEEP_PRODUCTION
DB_NAME=divedeep_prod
COOKIE_SECURE=true
CORS_ALLOW_ALL=false
DIVEDEEP_AUTO_APPROVE=false
```

Use different values in staging and development.

## 4. Compare complete environment files

```bash
npm run divedeep:environment-compare -- /secure/development.env /secure/staging.env /secure/production.env
```

Resolve every missing or duplicated environment identity before proceeding.

## 5. Run preflight

```bash
npm run divedeep:production-preflight
npm run divedeep:compatibility
```

Resolve every blocker before migration.

## 6. Dry-run schema 64

Static validation:

```bash
npm run divedeep:migration-dry-run
```

Shadow database validation:

```bash
DIVEDEEP_MIGRATION_DRY_RUN_ACK=DIVEDEEP_SHADOW_DATABASE \
  npm run divedeep:migration-dry-run -- --shadow-db=divedeep_prod_shadow_116 --drop-shadow
```

Never use the configured production database as the shadow target.

## 7. Capture rollback assets

Before applying the schema to an existing installation:

- Create a database backup
- Record its SHA-256
- Capture an object-storage snapshot or inventory
- Complete `deploy/rollback/ROLLBACK_MANIFEST.example.json`
- Verify the manifest with `npm run divedeep:rollback-verify -- <manifest>`

Fresh installations should still create a baseline backup immediately after successful setup.

## 8. Apply schema

```bash
npm run migrate
```

Schema 64 creates the release-readiness, rollout, disaster-recovery, and provider-readiness tables. It seeds each environment at `internal_test_records` with status `held`.

## 9. Complete existing installation setup

Use the existing installation flow to create the first root administrator and complete secrets, Google step-up authentication, GHL, private object storage, Cloud Run worker pools, HAWK, SONG, EAGLE, OWL, and Sentinel configuration.

Do not enable open production signup during the pilot. Use an invitation code or keep signup disabled.

## 10. Run automated verification

```bash
npm run phase10:verify
```

This includes Phase 10 checks and the regression chain through Phases 9, 8, and 5.

## 11. Run controlled staging rehearsals

Set:

```dotenv
DIVEDEEP_REHEARSAL_ACK=DIVEDEEP_CONTROLLED_REHEARSAL
```

Then execute the rehearsal sequence documented in `DIVEDEEP_PHASE10_PRODUCTION_HARDENING_ROLLOUT.md`.

Record each successful result through the administrative Phase 10 readiness API or the rehearsal command.

## 12. Rehearse disaster recovery

Restore the database and object-storage snapshot into isolated staging resources. Deploy v1.16.0 against the restored resources, verify customer-safe APIs, worker lease recovery, queues, reports, and Sentinel, then record actual RPO and RTO.

## 13. Release gate

```bash
npm run divedeep:release-gate
```

The gate must report:

- environment `ok: true`
- release gate `ready: true`
- rollout at `internal_test_records` or the explicitly approved next stage

## 14. Controlled rollout

Advance only in this order:

```text
internal_test_records
controlled_pilot
small_customer_cohort
normal_production
enterprise_clients
hourly_burst_capacity
multi_provider_capacity
```

The control plane prevents skipped stages. The pilot allows one active customer. The final stage requires two ready compute providers.

## 15. Production startup

```bash
npm start
```

The process refuses production startup when required separation controls are absent.

## 16. Post-deployment verification

Verify:

- health endpoint readiness
- root administrator Google step-up
- customer and enterprise scope isolation
- worker route rejection for external service identities
- private object access and deletion
- lease recovery
- CRM inbound and outbound queue processing
- signed webhook delivery and replay
- Sentinel event ingestion and alert handling
- throughput and cost review

Do not advance the rollout while any blocker, unexplained dead letter, cross-tenant anomaly, unbounded retry, or critical Sentinel alert remains open.
