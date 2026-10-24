# Phase 2 Focused Test Matrix

| Area | Validation |
|---|---|
| Workflow | Permanent gates, capacity wait, restricted consent, reference-image requirements |
| Cloud Run | Config validation, one-task enforcement, safe overrides, operation recovery, execution mapping |
| Database | Fresh-install tables, enums, seed pool, no persistent-node schema |
| Admin UIX | Required views, actions, script version, no duplicate IDs |
| Regression | Phase 1 catalog/manifests and Phase 1.1 Rekognition/security contracts |
| Syntax | Node syntax validation across changed source, admin bundles, and tests |

Live cloud, database, CRM, and external recon tests are intentionally excluded from this build stage.
