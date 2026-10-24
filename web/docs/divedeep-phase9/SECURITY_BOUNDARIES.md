# Phase 9 Security Boundaries

## External-safe

- customer ID and organization ID
- plan/status/workflow state
- normalized job status and numeric progress
- aggregate finding/removal/monitoring counts
- delivery method/provider/status and bounded failure code
- monitoring type/cadence/result and HTTP status
- timestamps
- client-supplied allowlisted integration event metadata

## Internal-only

- raw findings and exposure URLs
- evidence and artifact files
- object-storage keys, buckets, grants, and presigned URLs
- job manifests and worker execution names
- worker tokens, leases, checkpoints, and source-attempt payloads
- candidate images, face/person-analysis data, and confidence values
- authorization documents and document hashes
- encrypted customer identity fields
- removal destinations and provider response bodies
- reviewer notes and review assignments
- import batches and staged evidence
- administrative queues and control-plane mutations

## Authentication non-interchangeability

| Credential | Customer v1 | Enterprise v1 | Integrations v1 | Workers v1 | Admin |
|---|---:|---:|---:|---:|---:|
| Customer service identity | Yes | No | No | No | No |
| Enterprise service identity | No | Yes | No | No | No |
| Integration service identity | No | No | Yes | No | No |
| Worker job token | No | No | No | Yes | No |
| Admin session | No implicit service access | No implicit service access | No implicit service access | No | Yes |
| Legacy internal API key | Existing internal routes only | No | No | No | No |

## Outbound webhook network boundary

Webhook subscription and delivery perform public-address validation. Loopback, private, link-local, reserved, local-network, metadata, and non-routable addresses are blocked. Redirect following is disabled to prevent a public endpoint from redirecting delivery into an internal network. Response bodies are never persisted and are intentionally discarded.

