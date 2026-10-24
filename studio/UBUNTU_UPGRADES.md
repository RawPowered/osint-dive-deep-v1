# DiveDeep Ubuntu Upgrade Operations

Version: 5.28.0

## Persistent and release data

Application releases are immutable deployments:

```text
/opt/divedeep/
â”œâ”€â”€ releases/
â”‚   â”œâ”€â”€ 5.27.0/
â”‚   â””â”€â”€ 5.28.0/
â”œâ”€â”€ current -> releases/5.28.0
â”œâ”€â”€ previous -> releases/5.27.0
â””â”€â”€ known-good -> releases/5.28.0
```

Persistent data remains outside the release directories:

```text
/etc/divedeep/divedeep.env
/var/lib/divedeep/data
/var/lib/divedeep/backups
/var/cache/divedeep
/var/log/divedeep
```

## Upgrade sequence

```bash
sudo /opt/divedeep/current/deploy/ubuntu/upgrade.sh /path/to/DiveDeep-v5.29.0.zip
```

The script performs these operations:

1. Tests the ZIP archive.
2. Locates and verifies `RELEASE.json`.
3. Verifies declared release-file SHA-256 hashes.
4. Builds a release-specific Python environment before downtime.
5. Runs dependency checks and installs the pinned browser.
6. Creates SQLite and workspace-metadata backups.
7. Enables drain mode and stops the API and UI from accepting new work.
8. Waits for the currently running queue record to finish.
9. Stops the worker and requeues any interrupted running record.
10. Atomically changes the `current` symlink.
11. Starts the new services in drain mode.
12. Runs compatibility and health smoke tests.
13. Resumes work and runs the final readiness test.
14. Rolls back automatically if the new release fails validation.

The default drain timeout is 900 seconds. Override it with:

```bash
sudo /opt/divedeep/current/deploy/ubuntu/upgrade.sh release.zip --timeout 1800
```

## Rollback

Roll back to the previous release:

```bash
sudo /opt/divedeep/current/deploy/ubuntu/rollback.sh
```

Roll back to a specific installed release:

```bash
sudo /opt/divedeep/current/deploy/ubuntu/rollback.sh 5.27.0
```

Rollback does not delete the failed release. This preserves its logs and allows inspection.

## Manual maintenance controls

```bash
cd /opt/divedeep/current
sudo -u divedeep ./run.sh --status
sudo -u divedeep ./run.sh --drain
sudo -u divedeep ./run.sh --resume
sudo -u divedeep ./run.sh --version
```

Authenticated API equivalents:

```bash
curl -X POST http://127.0.0.1:8600/v1/system/drain \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Scheduled maintenance","requested_by":"operator"}'

curl -X DELETE http://127.0.0.1:8600/v1/system/drain \
  -H "Authorization: Bearer $DIVEDEEP_API_KEY"
```

## Backups

Create a manual backup:

```bash
sudo /opt/divedeep/current/deploy/ubuntu/backup.sh
```

Backups include consistent copies of SQLite databases and a compressed archive of workspace metadata. Large raw recon output and evidence files are intentionally excluded from the metadata archive.

## Verification

```bash
sudo /opt/divedeep/current/deploy/ubuntu/smoke-test.sh
sudo systemctl status divedeep-ui divedeep-api divedeep-worker
sudo journalctl -u divedeep-api -u divedeep-worker --since "10 minutes ago"
```
