# Phase 10 Rollout Runbook

## Internal test records

Use synthetic customers, synthetic images, and controlled GHL contacts. Complete every readiness rehearsal.

## Controlled pilot customer

Maximum active customers: 1. Assign a support owner and rollback decision owner. Observe onboarding, job completion, service updates, retention, monitoring, and CRM synchronization.

## Small customer cohort

Set an explicit cohort limit. Review daily queue depth, dead letters, worker loss, average job time, storage growth, support incidents, and provider cost.

## Normal production

Enable standard onboarding only after the small cohort is stable through a complete monitoring and retention interval.

## Enterprise clients

Create organization memberships and scoped service identities. Confirm the enterprise APIs expose only safe aggregate and status data.

## Hourly burst capacity

Use synthetic records to test the approved hourly capacity. Stop on database saturation, excessive retries, lease-recovery lag, or cost outside the approved envelope.

## Multi-provider capacity

Validate the secondary provider independently, then test controlled provider selection and provider loss without changing the worker protocol or privacy boundary.
