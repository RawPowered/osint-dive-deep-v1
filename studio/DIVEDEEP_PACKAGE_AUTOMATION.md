# DiveDeep package automation

Version: 5.27.0

## Launch

```bash
chmod +x run.sh
./run.sh
```

Open **Protection & System → DiveDeep Workflow**.

## Fast startup

1. Upload the DiveDeep customer JSON.
2. Confirm the detected package or choose the correct package manually.
3. Click **Import and create recon case**.
4. DiveDeep creates the local case folder, builds all authorized queues, and opens the Tool Runbook.
5. Click **Run all automatic jobs**.
6. Complete manual/provider tasks separately, review findings, and build the self-verified DiveDeep evidence-package ZIP.

## Package flows

### Standard Social

- Exact public-web discovery
- Sherlock and Maigret when authorized
- Declared-profile validation
- Up to 50 search results per exact query

### Deep Social

Everything in Standard Social, plus:

- Indexed image discovery by names and usernames
- Passive SpiderFoot correlation
- Expanded target and result limits
- Up to 75 text and 50 indexed-image results per query

### Image Discovery

Everything in Deep Social, plus:

- Authorized reference-photo fingerprinting
- Dedicated reverse-image review tasks
- Up to 100 text and 100 indexed-image results per query

### Sensitive Exposure

Everything in Image Discovery, plus:

- Separately authorized sensitive-source review
- Consent enforcement before the case is created
- Maximum package queue depth

## Authorization behavior

The selected package defines purchased scope. The intake packet still controls whether specific provider and sensitive queues are legal to create.

DiveDeep warns and excludes a queue when:

- Sherlock or Maigret is not authorized in the packet
- Image review is not authorized
- No reference images exist
- Sensitive-source authorization is absent
- Separate sensitive-content consent is missing

## Case folder

```text
${OSINT_STUDIO_DATA_DIR:-~/.local/share/osint-dive-deep}/divedeep-workspaces/<customer-id>/case/
```

Contents:

- `case.json`: customer, package, linked DiveDeep cases, queue counts, and warnings
- `package-flow.json`: package scope and limits
- `queue.json`: indexed jobs grouped by family
- `START-HERE.md`: local operator instruction

## Queue controls

- **Run all automatic jobs**: executes every ready package job sequentially
- **Run next pending**: executes one job
- **Run quick batch**: executes a bounded number of jobs
- **Run family queue**: executes one recon family
- **Include failed jobs**: includes failed jobs in the next run
- **Continue after failures**: retains errors and proceeds to the next job

Every executable job continues to route through:

```bash
./run.sh --divedeep-job <workspace> <job-index> --timeout <seconds>
```

Customers never control commands, tools, arguments, concurrency, or queue order.

## Result delivery

Use the Image Recon export control to create the segmented DiveDeep package. The generated ZIP is the preferred transport and can be imported directly in DiveDeep Admin. The same importer also accepts an extracted folder, a dragged folder, or the manifest, findings, and evidence files selected together.

The manifest contract includes explicit part numbers, finding keys, evidence MIME types, byte sizes, SHA-256 digests, and whether each evidence file requires upload. DiveDeep validates the completed ZIP before presenting it to the operator.
