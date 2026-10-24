# AI Instructions for OSINT Query Studio Templates

## Purpose

Use these instructions when an AI system is asked to design, revise, audit, or troubleshoot a reusable OSINT Query Studio hunt template.

A template is a portable JSON object that can configure:

- discovery terms and query lanes;
- geography and site restrictions;
- early candidate rejection filters;
- Visual Web Recon prefilters;
- grouped page-match rules;
- custom CSV extractors;
- selected output fields; and
- fetch and concurrency controls.

The canonical schema is:

```text
osint-query-studio-template-v2
```

Reference files:

```text
templates/template.schema.json
templates/template_starter.json
templates/template_starter.json
```

## Required AI behavior

1. Return valid JSON when the user asks for a template file. Do not surround the JSON with commentary unless the user asks for an explanation.
2. Preserve the canonical key names and capitalization used by the schema.
3. Use only supported query placeholders, rule sections, operators, extractor methods, and extractor sources.
4. Design several narrow query lanes instead of one excessively restrictive query.
5. Separate discovery evidence from confirmation evidence. Search terms discover candidates; Visual Web Recon rules confirm them.
6. Put obvious aggregators, vendor sales pages, directories, social networks, job pages, and case studies into early filters so they are rejected before page retrieval.
7. Use strong vendor-specific evidence in a dedicated fingerprint group and ordinary business identity evidence in a separate group.
8. Use required negative rules only for definitive exclusions. Do not mark every positive fingerprint as required.
9. Do not claim a technology, owner, person, phone, email, or operational status is verified merely because one weak signal matched.
10. Keep the work limited to public-web research. Do not add authentication bypass, CAPTCHA bypass, credential testing, exploit instructions, intrusive scanning, or access to nonpublic systems.

## Canonical top-level structure

```json
{
  "schema_version": "osint-query-studio-template-v2",
  "template_id": "portable_machine_name",
  "name": "Human-readable template name",
  "description": "What this template finds and how it confirms results.",
  "metadata": {},
  "matrix": {},
  "visual": {}
}
```

Required top-level keys:

```text
schema_version
name
matrix
visual
```

Recommended metadata:

```json
{
  "tags": ["industry", "vendor", "country"],
  "author": "Name or organization",
  "compatible_app_versions": "5.x",
  "objective": "Precise operational objective",
  "notes": "Important limitations or run strategy"
}
```

## Discovery matrix

Every multiline matrix value may be supplied as either:

- one newline-delimited string; or
- an array of strings.

The application normalizes arrays into newline-delimited values.

Supported matrix keys:

```text
bases
variants
geographies
excludes
sites
title_terms
url_terms
filetypes
templates
max_queries
candidate_excluded_domains
candidate_excluded_url_terms
candidate_excluded_title_terms
candidate_excluded_snippet_terms
candidate_required_url_terms
```

### Supported query placeholders

```text
{base}
{variant}
{geo}
{site}
{title}
{url}
{filetype}
{site_op}
{title_op}
{url_op}
{filetype_op}
```

Operator placeholders generate complete search operators:

```text
{site_op}      -> site:example.com
{title_op}     -> intitle:"Order Online"
{url_op}       -> inurl:"menu"
{filetype_op}  -> filetype:pdf
```

Do not invent placeholders.

### Query-lane design

Good:

```text
{base}
{base} {geo}
{base} {variant} {geo}
{variant} {geo} {title_op}
```

Usually too restrictive:

```text
{base} {variant} {geo} {site_op} {title_op} {url_op} {filetype_op}
```

Only dimensions referenced by a template are expanded. Use this deliberately to prevent unused fields from multiplying the query count.

### Candidate filters

Use candidate filters to reject noise before candidates enter the SQLite job database.

Examples:

```text
candidate_excluded_domains:
yelp.com
facebook.com
vendor.example.com

candidate_excluded_url_terms:
/case-studies
/blog/
/jobs

candidate_excluded_title_terms:
Case Study
Software Platform
Directory
```

Do not exclude an entire vendor parent domain when customer subdomains on that domain are valid targets. Exclude exact corporate subdomains instead.

## Visual matching

Canonical shape:

```json
{
  "matching": {
    "within_group": "OR",
    "between_groups": "AND",
    "minimum_score": 0
  },
  "prefilter": {},
  "rules": [],
  "extractors": [],
  "selected_fields": [],
  "fetch": {}
}
```

### Supported rule sections

Use exact capitalization:

```text
URL
Search title
Search snippet
Page title
Meta description
Head HTML
Visible header
Body text
Visible footer
All scripts
Footer scripts
Full HTML
```

### Supported rule operators

```text
contains
does not contain
equals
starts with
ends with
regex
exists
does not exist
```

### Rule object

```json
{
  "Group": "Vendor Fingerprint",
  "Group logic": "OR",
  "Section": "All scripts",
  "Operator": "contains",
  "Value": "vendor.example.com",
  "Case sensitive": false,
  "Required": false,
  "Weight": 45
}
```

### Recommended group architecture

Use three conceptual groups:

1. `Vendor Fingerprint` — distinctive platform evidence, OR logic.
2. `Entity Identity` — evidence that the page represents the desired business/entity, OR logic.
3. `Exclusions` — definitive negative checks, AND logic, usually marked required.

Recommended global relationship:

```text
between_groups = AND
```

This produces:

```text
at least one vendor fingerprint
AND
at least one entity-identity signal
AND
all required exclusions pass
```

### Weight guidance

```text
45-60  Exact vendor attribution, proprietary asset host, unique DOM marker
30-44  Strong script, URL, or full-HTML vendor reference
15-29  Supporting identity or behavior signal
5-14   Generic corroboration
1      Required negative rule; weight is not the controlling mechanism
```

Do not use a high minimum score until the alternatives have been calibrated. A score of `0` with grouped logic is a reliable starting point.

### Regex guidance

- JSON requires every backslash in a regex to be escaped.
- Regex `\s+` must appear in JSON as `"\\s+"`.
- Prefer bounded, vendor-specific expressions.
- Avoid catastrophic patterns such as nested unrestricted quantifiers.
- Use `contains` instead of regex when literal matching is sufficient.

## Custom extractors

Supported methods:

```text
Regex
CSS text
CSS attribute
JSON-LD key
```

Supported sources:

```text
Full HTML
Page text
Head HTML
Visible header
Visible footer
All scripts
Footer scripts
```

Canonical extractor:

```json
{
  "Column name": "vendor_asset_urls",
  "Method": "Regex",
  "Source": "All scripts",
  "Pattern or selector": "https?://[^\"'<> ]+",
  "Attribute": "",
  "Multiple": true
}
```

For CSS attribute extraction, set `Attribute` to values such as `href`, `src`, or `content`.

For JSON-LD extraction, use dot paths such as:

```text
name
telephone
email
address.addressLocality
address.addressRegion
address.postalCode
sameAs
```

## Fetch controls

Allowed ranges:

```text
workers: 1-16
timeout: 3-120 seconds
max_bytes: 250000-10000000
```

Canonical defaults:

```json
{
  "workers": 4,
  "timeout": 15,
  "verify_tls": true,
  "follow_redirects": true,
  "max_bytes": 2500000,
  "include_nonmatches": true
}
```

Keep `include_nonmatches` enabled during calibration so failed rules can be reviewed. Disable it for a final high-volume export after the rule set is proven.

## Template development workflow

1. Define the entity population and evidence standard.
2. Identify two to five high-confidence discovery phrases or technical markers.
3. Create separate query lanes for exact phrases, geographic shards, title operators, and hosted-domain searches.
4. Add candidate filters for obvious non-target domains and paths.
5. Add a strong fingerprint group.
6. Add an entity-identity group.
7. Add required exclusions.
8. Add extractors for evidence, contact fields, structured data, and social links.
9. Validate the JSON.
10. Run a small calibration job before scaling.
11. Review false positives and false negatives.
12. revise filters, rules, weights, and query lanes.

## Validation commands

From the project directory:

```bash
python template_cli.py validate templates/template_starter.json
```

Normalize or migrate a template:

```bash
python template_cli.py normalize my_template.json -o my_template.normalized.json
```

Install it into the local template library:

```bash
python template_cli.py install my_template.json
```

Generate a starter template:

```bash
python template_cli.py starter -o my_template.json
```

List available templates:

```bash
python template_cli.py list
```

Custom installed templates are stored under:

```text
~/.local/share/osint-dive-deep/profiles/
```

## AI completion checklist

Before returning a template, verify:

- JSON parses without comments or trailing commas.
- `schema_version` is exactly `osint-query-studio-template-v2`.
- Every query placeholder is supported.
- The matrix is not accidentally overconstrained.
- Excluded domains do not suppress valid customer subdomains.
- Every rule section and operator is supported.
- Every regex is JSON-escaped.
- Positive evidence is separated from exclusions.
- Required rules are used only for true mandatory conditions.
- Extractor names are unique and CSV-safe.
- Fetch values are within supported ranges.
- The template documents its objective and limitations.
