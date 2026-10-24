# DiveDeep External API v1 Contract

The examples below assume the configured public API base path is `/api`.

## Common headers

```http
Authorization: Bearer <service-api-key-or-oauth-access-token>
Accept: application/json
```

All responses include:

```http
X-DiveDeep-API-Version: 1
Cache-Control: no-store, max-age=0
```

Mutating integration requests also require:

```http
Idempotency-Key: <client-generated-unique-key>
Content-Type: application/json
```

## OAuth client credentials

```http
POST /api/integrations/v1/oauth/token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

 grant_type=client_credentials&scope=integrations%3Aevents%3Awrite
```

Body credentials using `client_id` and `client_secret` are also accepted. Tokens are opaque, expire after 3,600 seconds, and cannot expand the service identity's configured scopes.

## Customer API

```text
GET /api/customer/v1/
GET /api/customer/v1/me
GET /api/customer/v1/jobs?status=running&limit=100
GET /api/customer/v1/jobs/:jobId
GET /api/customer/v1/reports/removals
GET /api/customer/v1/reports/monitoring
```

The customer ID always comes from the authenticated identity. A request cannot select another tenant through a query parameter or body field.

## Enterprise API

```text
GET /api/enterprise/v1/
GET /api/enterprise/v1/coverage
GET /api/enterprise/v1/customers?status=active&limit=250
GET /api/enterprise/v1/customers/:customerId/jobs
GET /api/enterprise/v1/customers/:customerId/jobs/:jobId
GET /api/enterprise/v1/reports/removals
GET /api/enterprise/v1/reports/monitoring
```

Every customer path validates an active `divedeep_organization_customers` membership before reading customer data.

## Integrations API

```text
GET  /api/integrations/v1/
GET  /api/integrations/v1/webhooks
POST /api/integrations/v1/events
POST /api/integrations/v1/webhooks
```

Accepted external event types:

- `customer.lifecycle.requested`
- `customer.communication.requested`
- `integration.sync.completed`
- `report.requested`

Example event:

```json
{
  "externalEventId": "crm-event-01882",
  "eventType": "integration.sync.completed",
  "customerId": "00000000-0000-4000-8000-000000000000",
  "data": {
    "provider": "crm",
    "status": "complete",
    "recordsProcessed": 14
  }
}
```

Fields whose names indicate evidence, artifacts, storage, manifests, credentials, authorization documents, source URLs, destinations, reviewer notes, confidence, images, photos, candidates, raw data, or attachments are rejected recursively.

## Error shape

```json
{
  "error": "Human-readable bounded error",
  "code": "DIVEDEEP_MACHINE_READABLE_CODE"
}
```


## Webhook endpoint security

Webhook URLs must use HTTPS and resolve only to public IP addresses. DiveDeep rejects loopback, private, carrier-grade NAT, link-local, reserved/documentation, multicast, local-network, and cloud-metadata targets. Resolution is checked during subscription creation and immediately before delivery. HTTP redirects are not followed, and response bodies are discarded.

Delivery signatures use the exact request body:

```text
X-DiveDeep-Timestamp: <unix-seconds>
X-DiveDeep-Signature: v1=<hex-hmac-sha256>
```

The signed input is `<timestamp>.<raw-body>`.

Authentication failures use 401, scope and boundary failures use 403, missing records use 404, idempotency conflicts use 409, rate limits use 429, and transient control failures use 503.
