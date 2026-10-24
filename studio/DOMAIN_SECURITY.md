# Domain Security Command Center

The Domain Security Command Center handles one client domain and large authorized domain portfolios through the same case workflow.

## Workflow

1. **Scope** — enter a single domain, paste a list or import a CSV. Confirm client ownership or explicit authorization and record the engagement reference.
2. **Contact Enrichment** — import a CSV, map its domain or email fields, collect public contact/footer/social evidence, refresh batches and export enriched rows.
3. **Fingerprint** — make one bounded homepage request per selected domain. Preserve the response and inspect redirects, response headers, generator metadata, technologies and visible WordPress component paths.
4. **OWASP Analysis** — organize evidence and remaining work against OWASP Top 10:2025. The matrix labels automated, authenticated and manual work separately; absence of an alert is never reported as a pass.
5. **Tool Runs** — create reviewed, rate-limited commands for installed Kali tools. Mixed and active tools require a separate execution acknowledgment.
6. **Findings & Export** — review native and normalized tool findings and export one case-level JSON report or findings CSV.

## Tool coverage

| Tool | Primary use | Single | Bulk |
|---|---|---:|---:|
| Native baseline | Headers, technology and visible WordPress paths | Yes | Yes |
| Subfinder | Passive subdomain discovery | Yes | Yes |
| Assetfinder | Related subdomain discovery | Yes | One queued target at a time |
| theHarvester | Public hosts, email and subdomain discovery | Yes | One queued target at a time |
| GoSpider | Bounded same-site route and script discovery | Yes | One queued target at a time |
| Shodan | Indexed domain and service context | Yes | One queued target at a time |
| WhatWeb | Technology fingerprinting | Yes | Yes |
| HTTPX Toolkit | HTTP/TLS/technology inventory | Yes | Yes |
| Nuclei | Template-based validation | Yes | Yes |
| Nikto | Web-server configuration assessment | Yes | No |
| WPScan | WordPress core, plugin and theme analysis | Yes | One queued target at a time |
| testssl.sh | TLS protocols, ciphers and certificate review | Yes | One queued target at a time |
| Nmap | Port and service inventory | Yes | Yes |
| OWASP ZAP Baseline | Spider and passive scanner | Yes | One queued target at a time |
| OWASP ZAP Full Scan | Spider and active web-application testing | Yes | One queued target at a time |
| Amass | Related-domain and attack-surface discovery | Yes | One queued target at a time |
| SpiderFoot | Correlation and footprint analysis | Yes | One queued target at a time |

WPScan reads `WPSCAN_API_TOKEN` from the local environment when configured. The token is not inserted into command previews or case logs. WPScan can still fingerprint WordPress without the API token, but live vulnerability data may be unavailable.

## WordPress behavior

The native baseline identifies WordPress and component slugs already exposed in the fetched homepage HTML. It does not guess hidden components. WPScan provides the deeper authorized workflow for core, plugin and theme detection; Baseline uses passive component detection, while Standard and Deep progressively increase direct requests. No password guessing or credential attack workflow is generated.

## OWASP references

- Reporting categories: OWASP Top 10:2025
- Stable testing references: OWASP Web Security Testing Guide v4.2

Several Top 10 categories cannot be proven by an unauthenticated external scanner. Access control, insecure design, authentication, logging/alerting and business-specific exceptional conditions require authenticated testing, architecture evidence or client operational review.

## Kali packages

Install only the tools required for the engagement, then refresh local tool discovery:

```bash
sudo apt update
sudo apt install whatweb httpx-toolkit nuclei nikto wpscan testssl.sh nmap amass spiderfoot
```

OWASP ZAP packaging varies by Kali release. If `zap-baseline.py` is on `PATH`, DiveDeep registers the baseline plan automatically.
