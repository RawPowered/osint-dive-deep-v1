# DiveDeep API Integration Contract

Base API version: `v1`

The API is intentionally asynchronous. Long reconnaissance tasks are inserted into a SQLite-backed queue and executed by `divedeep-worker.service`. HTTP requests return quickly with a server job ID.

## Supported interactions

- Import a DiveDeep customer packet.
- List and inspect local DiveDeep workspaces.
- Rebuild the package-specific authorized tool plan.
- Run the next, all, family-specific, or selected pending jobs.
- Poll server job progress and events.
- Queue a normalized result export.
- Download the final DiveDeep JSON result packet.

## Not supported

- Arbitrary shell commands.
- Client-supplied executable paths or flags.
- Active vulnerability scanning through the DiveDeep API.
- Direct access to local evidence files.
- Public unauthenticated API calls.

## Run request modes

```json
{"mode":"all"}
```

```json
{"mode":"next"}
```

```json
{"mode":"family","family":"username-search"}
```

```json
{"mode":"selected","indices":[0,2,5]}
```

Only pending, installed, allowlisted jobs are accepted. Invalid or already completed indices are ignored. A request with no eligible jobs returns HTTP 409.

## Job states

```text
queued
running
completed
failed
cancelled
```

Each job response includes progress counters and an event history. A running queue survives API restarts because state is stored in `/var/lib/divedeep/data/server-jobs.sqlite`.

## 5.28 compatibility and maintenance endpoints

`GET /v1/version` now returns application/API versions, supported packet schemas, and feature flags.

`GET /v1/system/status` returns drain state, worker heartbeat, queue counts, and storage capacity.

`POST /v1/system/drain` blocks new intake, plan, run, and export requests while allowing the active queue record to finish.

`DELETE /v1/system/drain` resumes normal job acceptance.

DiveDeep should call `/ready` and `/v1/version` before dispatching work. A 503 response with `status: draining` is a temporary maintenance condition and should be retried later.
