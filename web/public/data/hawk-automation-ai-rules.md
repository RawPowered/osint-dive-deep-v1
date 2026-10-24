# HAWK automation generation rules

Generate JSON only. The root object must use `"format": "hawk-automation-1"` and contain `flows`.

Use the HAWK Live CRM Schema supplied with this file as the authority for runtime paths, custom-field IDs, data types, writable targets, and picklist values. Never invent a CRM field, field ID, object, action, trigger, or enum value.

Each graph must have schemaVersion `1`, exactly one trigger, at least one end node, unique safe node IDs, no cycles, no unreachable nodes, and every path must reach an end node. Conditions require exactly one true route and one false route. Every non-condition/non-end node requires `nextNodeId`.

Runtime values are templates such as `{{trigger.contactId}}`, `{{trigger.customFields.FIELD_ID}}`, `{{data.result}}`, or `{{steps.step_id.response.id}}`. Use only paths present in the live schema for `trigger.*`. Never use secret, token, password, credential, authorization, cookie, or API-key paths.

Use only actions listed in `x-hawk-catalog.actionDefinitions`. Respect every action field's `required`, `kind`, `options`, and `defaultValue` metadata.

- `ghl.update_contact` uses `config.contactId` and `config.fields`. Put custom values in `config.fields.customFields` as `{ "id": "FIELD_ID", "field_value": "{{trigger...}}" }`.
- `ghl.upsert_contact` uses `config.fields` and must include at least email, phone, firstName, or name. HAWK injects the selected location ID.
- `ghl.add_tags` and `ghl.remove_tags` use `config.contactId` and a non-empty `config.tags` array.
- `ghl.create_note` uses `contactId`, `body`, and optional `userId`.
- `ghl.create_task` uses `contactId`, `title`, ISO-8601 `dueDate`, and optional `body`, `assignedTo`, and `completed`.
- Opportunity actions use IDs supplied by the live connection. Never invent pipeline, stage, opportunity, or user IDs.
- `ghl.send_message` requires `contactId`, a supported `type`, and one of `message`, `html`, or `templateId`.
- `ghl.create_appointment` requires `contactId`, `calendarId`, and ISO-8601 `startTime`. Never invent calendar or user IDs.
- Object-record actions require a `schemaKey` present in `x-hawk-catalog.objects`; custom object keys start with `custom_objects.`. Properties must be a JSON object.
- `divedeep.evaluate_dialer_eligibility` requires `contactId` and returns an authoritative `eligible` boolean plus a stable `reason`. By default it is a pre-queue check and permits unassigned leads only when their lifecycle pool is Dialer-assignable. Set `scrubAllPhones: true` to have OWL fetch and scrub Primary Phone, Alternative Phone (`test-alternative-field`), and Phone 3 (`test-phone3-field`) and promote only a documented clean result into Primary Phone. Set `requireAlternatePhone: true` only for a No Answer recovery flow that must rotate away from the current Primary Phone. Provider `B` remains a non-callable review hold. Set `requireAssignment: true` for strict external-dialer flows. Set `enforceMarketingHours: false` only for a Manual Actions queue that does not itself place a call; DNC, phone availability, lifecycle, configured calendars, and Florida's three-attempt/24-hour guard remain enforced. Actual DiveDeep call authorization always enforces marketing hours and assignment. Branch on `steps.STEP_ID.response.eligible`; do not reproduce these checks with CRM tags or custom code.
- `data.set` uses a safe identifier in `config.key`.
- `webhook.send` sends a mapped JSON object to a public HTTPS URL. It supports `POST`, `PUT`, and `PATCH`. Use it to post from HAWK to a GoHighLevel Inbound Webhook workflow URL. Private, loopback, link-local, and non-HTTPS destinations are rejected.

Trigger definitions marked `adapter_required` are valid draft contracts but do not run automatically until the flow's signed webhook endpoint or polling adapter is enabled. Do not put endpoint IDs or webhook secrets in imported JSON; provision or rotate them in the HAWK trigger editor after import.

For GoHighLevel tag events, use a GoHighLevel workflow with `Contact Tag Added` followed by its outbound `Webhook` action. POST to the flow-scoped HAWK endpoint and set `Authorization: Bearer <HAWK secret>`. Include contact ID, location ID, tags, and every value referenced by the graph. HAWK checks the published trigger's tag filter before accepting the execution. Use `webhook.received` with optional `config.eventName` for non-CRM payloads.

`code.run` supports `javascript` or `python`, but it runs only in a separately configured isolated runner. It never receives GoHighLevel credentials, SQL access, host filesystem access, or network access. Prefer normal HAWK actions and conditions; use custom code only for transformations that cannot be represented declaratively. Put runtime values in `config.inputs`, not inside source code.

Imports create or replace drafts only. They do not publish or activate flows. Keep each flow under 100 nodes and the whole graph under 512 KB.
