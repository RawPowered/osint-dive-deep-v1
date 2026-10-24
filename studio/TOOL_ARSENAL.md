# Phase 4 — OSINT Tool Arsenal

Phase 4 turns the existing command builders into a case-aware arsenal. It remains a Kali-only, single-operator workflow and binds every local web service to `127.0.0.1`.

## SpiderFoot interfaces

The Kali package exposes two different interfaces:

- `spiderfoot` is the standalone scanner and local web application. Arsenal scans use `spiderfoot -s TARGET ... -o json`.
- `spiderfoot-cli` controls an already-running SpiderFoot web server. It is registered separately and is not used as the standalone scanner.

Install the Kali package with:

```bash
sudo apt update
sudo apt install spiderfoot
```

## Mission presets

| Preset | SpiderFoot selector | Default traffic class | Purpose |
|---|---|---:|---|
| Passive public sources | `-u passive` | Passive | Query SpiderFoot's passive module group. |
| External footprint | `-u footprint` | Mixed | Map externally visible assets. |
| Investigate indicator | `-u investigate` | Mixed | Enrich and correlate an indicator. |
| All configured modules | `-u all` | Active | Exercise all locally configured modules. |
| Selected event types | `-t TYPE,...` | Mixed | Select modules by output event type. |
| Selected modules | `-m MODULE,...` | Mixed | Run only explicit module IDs. |

Every mission emits JSON and applies an explicit maximum worker count. The command preview is authoritative: review it before acknowledging and running mixed or active work.

## Domain-security arsenal

Research → Domain Security reuses the same command preview, authorization acknowledgment, execution history and evidence pipeline for WhatWeb, HTTPX Toolkit, Nuclei, Nikto, WPScan, testssl.sh, Nmap and OWASP ZAP Baseline. It accepts one authorized domain or a case-level domain list, writes private target files for bulk-capable tools, and exposes rate and concurrency ceilings before execution. Nuclei JSONL and WPScan JSON receive dedicated normalization; every other tool still preserves exact stdout and stderr even when only generic observables can be normalized.

Passive describes expected collection behavior, not anonymity. The Studio does not conceal source IPs, rotate identities, bypass access controls, evade rate limits, defeat CAPTCHAs or implement anti-detection techniques. Authorized exposure simulation belongs in the later OSINT Analysis phase with explicit scopes and defensible telemetry.

## Exact evidence contract

For each attached tool execution, the Studio stores:

1. exact stdout bytes as a content-addressed `tool-output` artifact;
2. exact stderr bytes as a separate `tool-stderr` artifact when present;
3. the command, timestamps, exit status, timeout state and byte counts;
4. an unredacted raw-output evidence record linked to stdout; and
5. normalized events whose observations, claims and findings retain links to the raw artifact.

Values are not masked in the local case. This permits exact verification of exposed keys, identifiers or other sensitive values. Operators must protect the workstation, its case database, artifacts and exports accordingly.

## Normalized event contract

SpiderFoot JSON and recognized generic tool output are normalized to:

```text
event_type
data
module
source_data
confidence
raw
```

Recognized domains, URLs, IP addresses, email addresses, usernames, phone numbers, people and organizations are promoted into the shared entity/identifier graph. Events associated with breaches, leaked credentials, vulnerabilities, compromise, malicious indicators, open ports or similar exposure terms create reviewable findings. Normalization never replaces the raw artifact.

## Local SpiderFoot web UI

The Arsenal can start the SpiderFoot web application on a chosen loopback port. Use that interface to configure SpiderFoot module API keys and perform exploratory graph review. Opening the UI uses a separate browser tab. Stopping it archives the exact service log into the active case.

No credential is copied into hosted storage by OSINT Studio. SpiderFoot owns its module configuration; follow SpiderFoot's local configuration and backup workflow.

## Kali handoff smoke check

After transferring the release to Kali:

```bash
command -v spiderfoot
spiderfoot --help
./run.sh --check
./run.sh
```

Then create a disposable Research case and verify:

1. a passive SpiderFoot scan produces valid JSON;
2. stdout and stderr appear as separate case artifacts;
3. normalized observations link to the stdout artifact;
4. a known authorized exposure produces an unredacted finding;
5. the local UI listens only on `127.0.0.1`; and
6. stopping the local UI archives its service log.
