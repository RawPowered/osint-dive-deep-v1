# DiveDeep manual JSON bridge

This bridge keeps the current alpha simple:

1. DiveDeep Admin exports one authorized customer JSON packet.
2. DiveDeep imports that packet into a private local workspace and creates local case records.
3. The operator runs approved local tools, reviews results, and records only verified findings.
4. DiveDeep exports a compact result JSON packet.
5. DiveDeep Admin imports the packet and publishes exposures, request states, and verification outcomes to the customer dashboard.

No public DiveDeep server, worker queue, VPN, or VM orchestration is required.


## WebUI workflow

Open **Protection & System → DiveDeep Workflow** in DiveDeep. The interface provides five operator stages:

1. **Intake** — upload the DiveDeep Admin JSON packet and confirm authorization.
2. **Targets** — review identifiers, connected profiles, preserve rules, source sets, and generated files.
3. **Tool Runbook** — execute approved Sherlock or Maigret jobs one at a time, inspect raw output, and stage candidate URLs.
4. **Findings & Evidence** — review candidates, attach local evidence, prepare removal cases, and record verification results.
5. **Export** — generate and download `divedeep-results.json` for import into DiveDeep Admin.

The CLI remains available for batch or recovery work, but normal manual-alpha operations no longer require editing finding JSON files or using terminal commands.

## CLI import

```bash
python divedeep_cli.py import /path/to/divedeep-customer.json
```

The command prints the workspace path. It creates:

- `intake/divedeep-export.json`
- `targets/targets.csv`
- target lists by identifier type
- `tool-plan.json`
- `run-username-tools.sh`
- `finding-example.json`
- `results.json`
- `out/`

## Record findings

Copy `finding-example.json`, replace the example values, and run:

```bash
python divedeep_cli.py record /path/to/workspace /path/to/finding.json
```

A batch file may contain `{ "findings": [ ... ] }`.

Evidence files remain local. DiveDeep registers them in the existing case artifact store and exports only the artifact reference and SHA-256 hash.

## Export back to DiveDeep

```bash
python divedeep_cli.py export /path/to/workspace
```

Upload `out/divedeep-results.json` in DiveDeep Admin while the matching customer is selected.

## Safety defaults

- Import fails without active customer authorization.
- Preserved profile URLs are automatically marked `preserved`.
- Result packets contain no evidence binaries.
- Every result is bound to the original DiveDeep customer and profile IDs.
- The server rejects a result packet if its customer or profile does not match the selected customer.
- Re-importing the same listing URL updates the existing exposure instead of creating another one.
