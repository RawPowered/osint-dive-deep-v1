# Disaster Recovery Rehearsal

1. Freeze the rehearsal data set and record the source deployment fingerprint.
2. Create a consistent database backup and record SHA-256.
3. Capture object-storage version inventory or provider snapshot identifier.
4. Restore both into isolated resources with different credentials and DNS.
5. Deploy the exact backend, frontend, and worker versions in the compatibility matrix.
6. Run migration in the restored environment only when the backup schema is older than 64.
7. Verify customer login, customer-safe job summary, removal report, monitoring report, enterprise coverage summary, signed webhook delivery, GHL replay, worker bootstrap, lease recovery, and retention deletion.
8. Verify raw evidence and worker routes remain unavailable to customer and enterprise identities.
9. Measure recovery point objective and recovery time objective.
10. Record the result through the Phase 10 disaster-recovery control-plane endpoint.
11. Destroy or securely retain the isolated rehearsal resources according to policy.

A production traffic switch is not part of a routine rehearsal. It requires a declared incident or an approved controlled failover test.
