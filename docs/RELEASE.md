# Public source release

## Version and naming contract

Use **OSINT Dive Deep v1** as the product name and **1.0.1** as the current product release. The `v1` in the product/repository name identifies the product line; it does not replace the semantic release version. `release-manifest.json` owns the product name and release version. Packaging derives its version suffix from that manifest instead of maintaining a separate hard-coded version.

| Scope | Current value | Authority |
| --- | --- | --- |
| Product release | 1.0.1 | `release-manifest.json` → `version` |
| Studio/worker engine | 5.29.0 | `studio/osint_studio/__init__.py` → `__version__` |
| Web backend | 1.16.0 | `web/package.json` → `version` |
| Database schema | 64 | `web/RELEASE.json` → `schemaVersion` |
| Studio API contract | 1.1 | `studio/RELEASE.json` → `apiVersion` |
| Worker protocol | divedeep-worker-v1 | Compatibility matrix |
| Tested frontend compatibility | 1.7.0 | Compatibility matrix; not an independently packaged frontend release |

Component numbers are intentionally independent. Do not renumber the engine or backend to 1.0.1 to match the product. Historical migration/change documents and minimum-supported versions describe earlier contracts and should not be globally replaced. A separate older development checkout is not proof that this release's engine number is wrong.

The release gate rejects drift between product metadata, studio engine metadata, backend/package-lock metadata, the compatibility matrix's tested versions, and database schema metadata. Existing CI and packaging run this gate. A mismatch blocks packaging rather than silently choosing the highest number.

`release-manifest.json` is the explicit list of files permitted into public archives. `scripts/release_check.py` checks that list for runtime/private files, recognizable credentials, unreviewed URL hosts, non-example email addresses, high-entropy literals, and populated credential/origin settings in environment examples. Git-tracked files must also belong to the allowlist.

`release-policy.json` lists reviewed public providers and hashes of reviewed non-secret literals. These checks reduce accidental disclosure; they are not a guarantee against every possible secret format. Review changes before updating either policy or allowlist.

The initial documentation screenshots came from a separate local data directory and an empty “Documentation workspace” case. The newer map and query-planner captures use a separate isolated demonstration case with no external search results. Two historical UI captures are cropped or directly redacted. The branded frames add labels and borders around those reviewed captures; the underlying screenshots remain available separately for inspection. Provenance and approved hashes for both forms are recorded in `release-manifest.json`. Only reviewed screenshot hashes may be packaged. The original private source directory and its Git history are not imported.

Run from the repository root:

```sh
python scripts/release_check.py
python scripts/package_release.py
```

The Windows ZIP and Linux tar.gz contain the same complete source stack and platform launchers. They are source distributions; dependencies are installed during setup. The cloud worker is a Linux container. Verify downloaded archives against `SHA256SUMS.txt`.

The studio component has a generated `RELEASE.json` and file checksum inventory used by maintenance and cloud build tooling. If its source changes, run `python scripts/update_integrity.py` to refresh checksums for already-allowlisted studio files before creating a release.
