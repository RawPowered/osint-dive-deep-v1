# Public source release

`release-manifest.json` is the explicit list of files permitted into public archives. `scripts/release_check.py` checks that list for runtime/private files, recognizable credentials, unreviewed URL hosts, non-example email addresses, high-entropy literals, and populated credential/origin settings in environment examples. Git-tracked files must also belong to the allowlist.

`release-policy.json` lists reviewed public providers and hashes of reviewed non-secret literals. These checks reduce accidental disclosure; they are not a guarantee against every possible secret format. Review changes before updating either policy or allowlist.

Documentation screenshots come from a separate local data directory and an empty case named “Documentation workspace.” No targets, people, properties, external searches, or real customer records were loaded. Only reviewed screenshot hashes may be packaged. The original private source directory and its Git history are not imported.

Run from the repository root:

```sh
python scripts/release_check.py
python scripts/package_release.py
```

The Windows ZIP and Linux tar.gz contain the same complete source stack and platform launchers. They are source distributions; dependencies are installed during setup. The cloud worker is a Linux container. Verify downloaded archives against `SHA256SUMS.txt`.

The studio component has a generated `RELEASE.json` and file checksum inventory used by maintenance and cloud build tooling. If its source changes, refresh its checksums before creating a release.
