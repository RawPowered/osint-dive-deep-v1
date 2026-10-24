# Second Compute Provider Readiness

The secondary provider must execute a single disposable container per DiveDeep job and use the existing `divedeep-worker-v1` bootstrap, session, lease, heartbeat, artifact-grant, completion, and cleanup protocol.

Required controls:

- No permanent worker API credential
- No direct database connectivity
- No public artifact bucket
- One job per execution
- New bootstrap token for every dispatch or redispatch
- Heartbeat interval below the configured lease duration
- Zero local persistence after cleanup acknowledgement
- Provider retries disabled or bounded so API-owned retries remain authoritative
- Provider logs must not contain authorization documents, images, evidence, tokens, or raw result payloads
- Egress restricted to the API, approved source targets, and private object storage grants
- Package version and worker protocol validated before readiness is marked `ready`

The production rollout cannot enter `multi_provider_capacity` until at least two providers are recorded as ready.
