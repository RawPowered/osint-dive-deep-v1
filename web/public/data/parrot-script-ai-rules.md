# PARROT managed Python generation rules

Generate JSON only. The root object must use `"format": "parrot-script-1"` and contain a non-empty `scripts` array. Imports create or replace drafts only; they never deploy or run live.

Use the PARROT Live Python Schema supplied with this file as the authority for CRM runtime paths, HAWK templates, field IDs, data types, writable status, picklist values, available helpers, and capabilities. Never invent a CRM field or field ID.

Each script object requires:

- `name`: human-readable name, 1-191 characters.
- `slug`: stable command ID matching `custom.[a-z][a-z0-9_.-]+`.
- `description`: concise purpose and output summary.
- `source`: restricted Python defining exactly `run(inputs, context)`.
- `capabilities`: only `network.http` and/or `network.dns` when actually required.
- `inputSchema`: JSON Schema describing every input expected from HAWK.
- `changeNote`: what the generated version adds or changes.

PARROT does not receive CRM credentials and cannot query CRM directly. Use the live schema's `x-parrot-catalog.crmFields` entries to design input properties. A HAWK workflow maps `hawkTemplate` values such as `{{trigger.contactId}}` or `{{trigger.customFields.FIELD_ID}}` into the PARROT command's inputs. Python reads only `inputs` and the non-secret execution `context`.

Managed Python rules:

- Define exactly `def run(inputs, context):` with no defaults, annotations, decorators, async behavior, or generators.
- Imports, filesystem access, environment access, subprocesses, dynamic evaluation, reflection, private/dunder attributes, classes, and module-level executable statements are prohibited.
- Module-level constants must be literal values. Helper functions are allowed under the same restrictions.
- Return JSON-safe dictionaries, arrays, strings, numbers, booleans, or null-equivalent values.
- Keep source under the maximum declared by the schema and keep loops bounded. `range()` is limited to 100,000 items.
- Never place secrets, service tokens, authorization headers, cookies, credentials, or private keys in source, inputs, or output.

Available helpers:

- `http_get(url, timeout=5)` requires `network.http`. It performs a bounded GET, does not follow redirects, rejects URL credentials and nonstandard ports, and only permits approved public hosts.
- `dns_lookup(host)` requires `network.dns`. It resolves only configured approved hosts and rejects private, local, link-local, and reserved addresses.
- `sha256(value)`, `json_encode(value)`, `json_decode(text)`, and `url_parse(url)` require no capability.

Only request a network capability if the source calls its helper. Network helpers also require the target to be configured in the Python service's `PARROT_RECON_ALLOWED_HOSTS`; an empty allowlist denies all network use. Prefer HTTPS. Do not generate broad scanners, port probes, credential tests, evasion, persistence, destructive actions, or code that targets systems outside the approved business scope.

Design dry-run-friendly scripts. Use `context.get("dryRun")` when the result should explicitly identify test execution. A successful import is still a draft: validate and dry-run in PARROT Studio, inspect the output, and deploy separately before selecting it as a live HAWK command.

