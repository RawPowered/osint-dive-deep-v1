# Firefox Structured Capture Receiver

The Firefox companion connects a manually opened page to one selected property-owner review row. On permitted domains it reads the active tab only after the toolbar button is opened. Sources whose current terms prohibit automation, or whose reuse terms remain unverified, switch to manual-entry mode and are not scanned. The popup shows the closest queued row, checks whether it is already filled, and requires either an extension confirmation or an explicit Studio signal before submission.

## Start OSINT Studio and the receiver

```bash
cd ~/OSINT/Nightengale
chmod +x run.sh
./run.sh --with-receiver
```

Run the receiver without Streamlit when diagnosing the extension:

```bash
./run.sh --receiver
```

The receiver is fixed to `127.0.0.1`. Its default port is `8765`; set `OSINT_RECEIVER_PORT` to another unprivileged local port if necessary. The terminal prints the extension token. The same token can be explicitly revealed under **Unified Report -> Firefox structured receiver**.

## Load the extension in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Select `firefox_extension/manifest.json`.
4. Open the add-on's **Receiver settings**.
5. Keep the URL as `http://127.0.0.1:8765`, paste the printed token, save and test.

Firefox removes a temporary extension after browser restart. Reload the same manifest during development. Packaging/signing can be added after the workflow is stable.

## Capture workflow

1. Build the owner-verification queue in the Unified Report.
2. Select a property row and open its public record manually.
3. Open the DiveDeep toolbar popup. For Florida Residents Directory, National Public Data or BeenVerified, type the visible record name and address into the manual-entry fields; the extension does not scan those pages.
4. Confirm the expected owner/address row, similarity scores and existing status.
5. Choose **Owner name + address** or **Public-profile language**.
6. Either select **Confirm and send**, or select **Wait for Studio signal** and click **Signal Firefox** on the selected Studio row.
7. The extension optionally re-scans, the receiver repeats the close-name check, and a structured receipt is written into the same Unified Report.

## Capture policy

- Active-tab permission is granted only when the user opens the extension. Automatic structured scanning is disabled for manual-entry-only sources.
- The receiver accepts structured names, addresses, page URL/title, a SHA-256 page-state hash, match scores and optional language evidence.
- Raw HTML, DOM, full page text and arbitrary raw-content fields are rejected.
- A close name match is mandatory and is rechecked server-side.
- A differing visible address is stored as a conflict, not silently accepted.
- Existing verification or language fields require explicit replacement.
- LLCs, corporations, realty/property-management companies and similar owners are blocked from people capture and routed to Sunbiz or the applicable business registry.
- Public-profile language capture stores the observed language, URL and confidence. It does not infer language from race, ethnicity, surname or neighborhood data.
