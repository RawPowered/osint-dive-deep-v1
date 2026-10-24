# CSV Contact Enrichment

Contact Enrichment appends public, source-backed contact fields to an existing dataset without replacing its original columns.

## Use

1. Open **Research → Domain Security → Contact Enrichment**.
2. Upload a CSV and map its website/domain column. If no website column exists, map an email column to derive an organization domain.
3. Optionally map existing email and phone columns so they remain visible beside the enrichment output.
4. Confirm the domains are authorized for direct public-page collection and create the job.
5. Run only missing/failed rows or refresh all from a selected starting row.
6. Review the table and download the enriched CSV.

## Collection path

For each eligible domain, DiveDeep requests the HTTPS homepage and falls back to HTTP only if the HTTPS fetch is unsuccessful. It then follows a bounded number of same-domain links whose labels or paths indicate contact, about, team, staff, support, location or customer-service content.

When **Render browser DOM for dynamic contact links** is enabled, DiveDeep reuses one local headless Chromium process for the batch. After the configurable settle interval, it reads live `a[href^="mailto:"]`, `a[href^="tel:"]` and supported social-profile anchors from the rendered DOM. It also scans the complete rendered document after decoding HTML entities and common JavaScript Unicode/hex escapes. Cloudflare `data-cfemail` and `/cdn-cgi/l/email-protection` representations are decoded locally. This catches contact data inserted by client-side JavaScript or embedded in page markup rather than exposed as a conventional anchor. Each bounded rendered DOM is stored as a separate case artifact. Install local Chromium on Kali with:

```bash
./run.sh --install-browser
```

If Chromium is unavailable, the row reports `browser_dom_status=unavailable` and the static collector still completes.

Every fetched page is preserved through the existing case evidence pipeline. The merged row includes:

- resolved site URL and title;
- all publicly displayed email addresses;
- email addresses hosted on the supplied domain;
- role addresses such as `info`, `sales`, `support` and `privacy`;
- other email addresses publicly displayed by the site;
- displayed and normalized phone numbers;
- published Schema.org names and postal addresses;
- contact-form page or action URLs;
- Facebook, Instagram, LinkedIn, YouTube, X and TikTok links;
- visited source/contact URLs;
- bounded footer contact text;
- detected technologies;
- collection status, error, timestamp, page count and refresh count.

Machine endpoints that resemble email addresses, including Sentry ingestion DSNs, are excluded from accepted email columns and recorded under `filtered_non_contact_emails` with their exclusion reason. Their original occurrence remains available in the captured source artifact for audit and parser refinement.

The collector does not use data brokers, private-account guessing, credential access or inferred contact ownership. A named address published by the supplied website can be captured as public site evidence, but it is not asserted to be personal, current or deliverable without analyst review.

## Email-derived domains

When the CSV has only an email column, DiveDeep derives the domain after `@`. Common consumer mailbox providers such as Gmail, Yahoo, Outlook, iCloud and Proton are marked `mailbox-domain-skipped`; the tool does not visit the mailbox provider and pretend its corporate contacts belong to the person in the input row.

## Refresh controls

- **Incomplete or extractor upgrade** advances through unfinished rows and automatically revisits completed rows produced by an older contact parser or an unavailable browser pass.
- **Refresh all** revisits a selected range using the starting-row control.
- Page, timeout, response-size, browser-settle and concurrency ceilings keep each batch bounded.
- Refreshes update enrichment columns while retaining the original uploaded CSV artifact and every captured page artifact.
