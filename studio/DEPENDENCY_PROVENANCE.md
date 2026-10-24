# DiveDeep dependency provenance

Historical upstream selection record from the supplied engine source. The public v1 release retains these compatibility pins and checks the worker container build in CI; the dated selection notes below are not claims about today's latest versions.

Verified: 2026-07-28

This record covers the direct dependencies installed in the Google Cloud Run worker image. Stable releases were selected; development and prerelease artifacts were excluded.

## Container base

- `python:3.12-slim-bookworm` resolves to Python `3.12.13-slim-bookworm`.
- Multi-platform index digest: `sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b`.
- Linux/amd64 manifest digest: `sha256:72d3d75f2639ab82b34b29390ad3d6e0827c775befee94edda8e9976818f488d`.
- Official-image source revision: `docker-library/python@3362634339580d3232e65a66dd5a36c47ae7ff14`.
- The digest was verified live against Docker Hub on 2026-07-28. The Dockerfile pins the multi-platform index so Cloud Build selects the matching platform from the same verified release.
- Cloud Build Docker builder: `gcr.io/cloud-builders/docker@sha256:680b2a8d18a794c165cf97a3f9476784d5d962e945d424cb40b3e086cde0c284`, verified live against Google Container Registry on 2026-07-28.

## Python packages

| Package | Locked version | Upstream verification | Upstream release commit |
|---|---:|---|---|
| Requests | 2.34.2 | https://github.com/psf/requests/releases/tag/v2.34.2 | `6e83187` |
| Beautiful Soup | 4.15.0 | https://github.com/conda-forge/beautifulsoup4-feedstock/blob/main/recipe/meta.yaml | Source archive SHA-256 `288e3ca7d54b06f2ac191970bc275c1939cb46d450b255bf6718b04aa37ab4f7` |
| DDGS | 9.14.4 | https://github.com/deedy5/ddgs/releases/tag/v9.14.4 | `a4bf2f2` |
| Pillow | 12.3.0 | https://github.com/python-pillow/Pillow/releases/tag/12.3.0 | `bb1d8e8` |
| Sherlock Project | 0.16.0 | https://github.com/sherlock-project/sherlock/releases/tag/v0.16.0 | `524415b` |
| Maigret | 0.6.1 | https://github.com/soxoj/maigret/releases/tag/v0.6.1 | `de8d08e` |

Beautiful Soup's maintained upstream development repository is Launchpad rather than GitHub. The current 4.15.0 source version and source-archive digest were therefore verified through the live conda-forge feedstock on GitHub. The archived `wention/BeautifulSoup4` mirror was not treated as authoritative.

The generated lock files are the installation authority for the Cloud Run image:

- `requirements-cloud-worker.lock.txt`
- `requirements-sherlock.lock.txt`
- `requirements-maigret.lock.txt`

They resolve the direct inputs for Python 3.12 on Linux and include hashes for downloaded distributions.

The closures were generated with `uv 0.11.18` for CPython 3.12 on `x86_64-manylinux_2_28`, using `uv pip compile --generate-hashes`. Resolution did not install or execute the packages. The human-readable direct input files remain the review surface; the three `.lock.txt` files are the container installation authority.

Maigret 0.6.1 depends on `socid-extractor`, whose available releases constrain Beautiful Soup below 4.15. DiveDeep core requires the current Beautiful Soup 4.15.0 release. The Cloud Run image therefore installs core, Sherlock, and Maigret into separate virtual environments. Their command entry points remain available on `PATH`, while their Python dependency graphs remain isolated. Regenerate the locks only after repeating upstream release verification.
