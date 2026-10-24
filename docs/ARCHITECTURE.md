# Complete stack

`studio/` is the investigation application: the local Streamlit interface, SQLite case store, DuckDB property workspace, authenticated FastAPI interface, and headless job worker. `studio/cloud_worker.py` is the container entry point; the worker implementation is in `studio/osint_studio/cloud_worker.py`.

`web/` is the Node/Express control plane. It includes customer and administrator routes, identity verification and privacy workflows, MySQL schema 64, integration adapters, worker leases, artifact handling, and staged deployment checks. Its public directory contains the matching web UI.

`frontend/` contains the standalone frontend source. For split hosting, configure its runtime API origin and the backend's exact CORS origins. Keep it synchronized with the matching pages in `web/public/`.

Local studio use needs neither MySQL nor a cloud account. Hosted jobs need a configured web backend, private object storage, and a worker provider. Cloud Run is the supplied provider; the cloud worker runs in Linux containers even when administration happens from Windows.

Compatibility identifiers are studio/worker 5.29.0, web API 1.16.0, frontend 1.7.0, worker protocol `divedeep-worker-v1`, and template schema `osint-query-studio-template-v2`. These are engine contracts, independent of the public v1.0.1 release name. Renamed environment variables and routes use `DIVEDEEP` / `divedeep`; do not point this fresh public installation at an existing private database.

This is a source release. Cloud provider execution, real customer onboarding, paid integrations, and production migration rehearsals require operator configuration and separate validation. Included unit and contract tests use synthetic fixtures.
