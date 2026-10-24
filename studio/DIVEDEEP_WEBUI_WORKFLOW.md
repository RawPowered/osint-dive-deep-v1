# DiveDeep DiveDeep point-and-click workflow

Version: 5.27.0

## Launch

The operator launches DiveDeep only through:

```bash
chmod +x run.sh
./run.sh
```

`app.py` remains an internal Streamlit entrypoint used by `run.sh`. It is not the operator launch command.

## Complete manual-alpha path

Open:

**Protection & System → DiveDeep Workflow**

The workflow is one continuous local operation:

```text
DiveDeep JSON intake
→ authorized target review
→ mission queue generation
→ point-and-click local execution
→ raw-output capture
→ observable normalization
→ candidate review
→ evidence and removal-case recording
→ DiveDeep result packet export
```

## 1. Intake

- Upload the schema-version 2 JSON exported from DiveDeep Admin.
- Confirm active, non-revoked authorization.
- Create or refresh the private customer workspace.
- Review plan level, jurisdiction, consent state, connected profiles, and processing instructions.
- Download each authorized reference image from DiveDeep Admin and attach it in Intake.
- DiveDeep verifies the recorded SHA-256 when a full digest is present and stores the image under `evidence/reference-photos/`.

## 2. Package-matched targets and mission builder

DiveDeep imports now map to one of four package flows: Standard Social, Deep Social, Image Discovery, or Sensitive Exposure. Import creates the local recon case folder and package queue automatically, then opens the Tool Runbook. The operator may correct the package selection or use an advanced local family override.

The mission builder creates jobs only from authorized packet values. Presets are editable through fixed tool-family choices, not shell strings.

### Exact web discovery

Uses the installed DiveDeep `ddgs` dependency to search exact:

- Names
- Aliases
- Emails
- Phone numbers
- Addresses
- Usernames

### Indexed image discovery

Uses DDGS image search for authorized names, aliases, and usernames. These are candidate image pages, not biometric confirmation.

### Username discovery

Runs:

- Sherlock
- Maigret

Username candidates may come from an explicit username, a safe email local-part, an alias that already has username syntax, or the final segment of a declared profile URL.

### Passive correlation

Runs SpiderFoot using its passive source group with conservative thread limits against supported names, aliases, emails, phones, usernames, and explicit domains.

### Declared profile validation

Performs a bounded public HTTP metadata fetch against customer-declared public profile URLs. Private, loopback, link-local, reserved, and authenticated URLs are rejected.

### Authorized photo review

- Creates a local photo-fingerprint job.
- Creates a separate manual reverse-image provider step.
- Does not pretend that Sherlock or Maigret perform image recognition.

### Sensitive review

Creates a restricted manual task only when the packet contains separate sensitive-content consent and the corresponding source set.

## 3. Point-and-click execution

The Tool Runbook provides:

- **Run all automatic jobs**
- **Run family queue**
- **Run next pending**
- **Run quick batch**
- **Run selected job**
- **Retry selected**
- **Skip selected**
- **Mark manual job complete**

Every executable button routes the job back through:

```bash
./run.sh --divedeep-job <private-workspace> <job-index> --timeout <seconds>
```

The workspace and job index are validated by DiveDeep. The browser never supplies an executable, arbitrary argument list, or shell command.

Each completed job stores:

- Exact combined output
- Return code
- Timeout state
- Duration
- Output path
- Normalized observable count
- Candidate URL count
- Staged finding count

## 4. Automatic data capture

DiveDeep normalizes public observables from tool output into `observables.json`, including where available:

- URLs
- Emails
- Domains
- Account/profile links
- IP addresses
- SpiderFoot event values

The **Captured data** tab provides a filterable table and a JSON download. Raw values remain local until an operator confirms that they belong to the protected person.

Search, image, username, correlation, and declared-profile outputs automatically stage public URLs as `review` findings. Automatic staging never marks an identity match as confirmed.

## 5. Findings and evidence

For each candidate, the operator can:

- Confirm, reject, preserve, ignore, or keep it under review
- Record match confidence and matching basis
- Attach screenshots, page saves, or supporting files
- Create a removal case
- Select a DiveDeep privacy-request template
- Record delivery and acknowledgement states
- Record removal verification, continued presence, or reappearance

Customer preserve policies continue to override removal-case creation.

## 6. Export

From Image Recon, build the import-ready segmented evidence package:

```text
exports/divedeep-result-bundle-<customer>-<batch>.zip
```

The ZIP contains `manifest.json`, ordered `findings/findings-####.json` parts, and authorized evidence binaries under `evidence/`. DiveDeep recalculates file hashes, verifies byte sizes and package structure, and only exposes the archive after reopening it successfully. Import the ZIP directly in DiveDeep Admin, select the extracted folder, or drag the folder into the importer. Raw provider output that is not declared as evidence remains on the private DiveDeep workstation.

## Workspace files

```text
manifest.json
operator-state.json
observables.json
intake/divedeep-export.json
intake/operator-records/
targets/
tool-plan.json
raw/<tool>/
evidence/reference-photos/
evidence/operator-uploads/
results.json
out/divedeep-results.json
```

## Operational boundary

- DiveDeep remains local and loopback-only.
- DiveDeep remains customer-facing.
- Customers never control tools, commands, flags, targets, concurrency, or queue order.
- Only public-source identity research authorized by the customer is included.
- Network scanners and vulnerability-testing tools are not part of the DiveDeep identity mission.
- Candidate records require human identity review before any removal request is treated as approved.
