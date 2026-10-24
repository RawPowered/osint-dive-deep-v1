# HAWK + GoHighLevel Power Dialer deployment

## What controls what

- GoHighLevel `Manual Call` actions are the actual Power Dialer queues shown in **Conversations > Manual Actions**.
- HAWK decides whether a contact may be queued, selects its service pool, writes Assigned Dialer, and sends one Manual Call webhook to GoHighLevel.
- `custom_objects.dials` is the Call Center reporting/history mirror. It is not the Manual Actions queue.
- OWL remains authoritative for lifecycle pool, DNC, phone availability, configured calendars, attempt limits, user pool permissions, and each pool's final fallback dialer. In the temporary Manual Actions queue mode, HAWK does not use marketing hours to prevent enrollment; operators must stop calling outside approved hours. Direct DiveDeep call authorization still enforces marketing hours.

## Deploy HAWK first

1. Deploy the current application files and run `npm run migrate` to create OWL pool-permission and HAWK assignment-audit tables.
2. In **OWL > Dialer Users**, edit every eligible user, enter the user's GoHighLevel CRM user ID, and select the service pools that user may receive through round robin.
3. In **OWL > Service Pools**, set a CRM-mapped **Default fallback dialer** for every active calling pool.
4. Import `hawk-power-dialer-webhook-pack.json` with the correct Private Integration selected. Choose **Re-import and update matching draft** so the package updates the existing flow by name; do not choose Clone.
5. Validate both imported flows, but do not publish eligibility until the GHL inbound URL is configured on **Send Manual Call request**.
6. Preserve the already-working HAWK inbound webhook endpoints and secrets. Generate them only for a newly created flow.
7. Activate both flows after the updated drafts are published.

## Build GoHighLevel workflows

1. Open `ghl-single-manual-call-webhook.md` and configure one inbound receiver workflow.
2. Pause the six legacy pool workflows **CC 10 through CC 15** before enabling the receiver.
3. Keep one published GHL Manual Actions workflow per service pool. HAWK enrolls a contact by adding `hawk-dialer-ready` and then the matching `cc-pool-*` tag after assignment.
4. Keep the already-working eligibility and outcome webhook workflows; their edit prompts remain in `ghl-power-dialer-workflow-prompts.md`.
5. In the two HAWK-bound Webhook actions, verify every dynamic Custom Data value has a GoHighLevel merge-field chip. Typed labels such as `Contact ID` or `Call_outcome` are not dynamic values.
6. Verify the eligibility payload has `eventName`, `contactId`, `name`, and `serviceType`; verify the outcome payload has `eventName`, `contactId`, `name`, `callOutcome`, `nextCallAt`, and `servicePool`.
7. Review every generated trigger, field, tag, assignment, wait, and Webhook header before publishing.
8. Keep the eligibility and outcome bridge workflows in Draft until each Webhook test returns HTTP `202` with `accepted: true`.
9. In the single receiver Manual Call action, set **Assign To User** to `{{contact.assigned_dialer}}`. Do not configure owner, fixed-user, round-robin, pool branches, or assignment branches in GoHighLevel.
10. In receiver Workflow Settings, enable **Allow Re-entry**. A contact cannot re-enter while its Manual Call execution remains active, but can re-enter after completion for a later callback or permitted retry.

## Agent process

1. Start the queue from **Conversations > Manual Actions**.
2. Make the call.
3. Set contact custom field **Call_outcome** to exactly one of:
   - `no_answer`
   - `callback`
   - `scheduled`
   - `not_interested`
   - `dnc`
4. For `callback`, set **CC Next Call At** before completing the task.
5. Delete/complete the Manual Call task. GoHighLevel then adds `cc-outcome-submit`, and HAWK processes the result.

## Safe test order

1. Use a clean test contact in a Dialer-assignable lifecycle pool with a supported `service_type` value.
2. Add `cc-recheck`.
3. Confirm one successful HAWK execution and that Assigned Dialer was selected from existing field, owner, permitted round robin, or the pool fallback.
4. Confirm one Manual Call appears under the single HAWK receiver workflow.
5. Set `Call_outcome=no_answer`, complete the task, and confirm HAWK creates a Call Center outcome record and adds `cc-await-retry`.
6. Repeat with `callback`, `scheduled`, `not_interested`, and `dnc` before enabling production enrollment.

## Fail-closed rules

- Never create Manual Call tasks directly from `cc-recheck`.
- Never create a Manual Call task before the HAWK assignment action and outbound webhook succeed.
- Never bypass HAWK for a retry; retry and callback schedulers add `cc-recheck` so OWL performs a new decision.
- A missing or unsupported `Call_outcome` is routed to `cc-outcome-review` and is not requeued.
