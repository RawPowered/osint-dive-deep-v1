# Web dependency provenance

The public v1 release uses `package-lock.json` as its installation authority. Run `npm ci --ignore-scripts`; production can additionally omit development dependencies.

The dependency tree was refreshed on 2026-10-24. The MySQL session adapter pins an older MySQL client internally, so its `mysql2` dependency is explicitly overridden to the same version range as the application's maintained MySQL client. The release lockfile resolves both to 3.24.6. This keeps the existing adapter interface and removes the vulnerable nested client.

After a clean install, `npm audit` reported zero known vulnerabilities on 2026-10-24. This result is time-sensitive; rerun the audit when maintaining or deploying the application. The complete contract suite and available extended tests run in Windows/Linux CI; live MySQL/provider operation still requires operator validation.

Google Cloud Run and AWS SDK dependencies remain explicitly versioned in the package manifest. The cloud worker has separate hash-locked Python dependencies and a container build check. No provider account or credential is part of this repository.
