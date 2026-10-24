# GoHighLevel Workflow AI prompts for the HAWK Power Dialer

Use one prompt at a time from inside the matching existing GoHighLevel workflow. Each section is a self-contained in-place edit request. Never ask Workflow AI to create, clone, duplicate, or rename a workflow, and never combine prompts.

The webhook triggers, endpoint URLs, methods, and authentication are already working. Prompts **CC 01** and **CC 02** must preserve them. When reviewing any proposed edit, confirm it modifies the currently open workflow only and preserves unrelated working settings. For Webhook Custom Data, confirm every dynamic value is a GoHighLevel merge-field chip rather than typed example text.

## CC 01 — Send Eligibility Signal to HAWK

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 01 - Send Eligibility Signal to HAWK". Its purpose is only to turn a Call Center recheck request into an authenticated HAWK eligibility execution.

Preserve the existing cc-recheck trigger, enrollment settings, and working HAWK webhook connection exactly as configured. Do not recreate or replace the trigger or Webhook action. Locate the existing Webhook action named "Run HAWK OWL Eligibility" and preserve its current POST URL, Authorization header, secret, and standard contact-data setting. Only edit its Custom Data mappings as described below.

Under Custom Data add exactly these keys and values:
- eventName: fixed text call_center.eligibility
- contactId: native Contact ID merge field
- name: native Contact Full Name merge field
- serviceType: contact custom field service_type, field ID 04r14svrWH36Knji7YcY

Use GoHighLevel's field picker for contactId, name, and serviceType. Do not type their labels as literal values. Do not use the Services field with ID uO4QvsQSGHBM4Vh48v0L; it is a boolean and is not the service-routing field. Do not add delays, AI actions, custom code, Manual Call actions, tag mutations, or other CRM mutations. Leave the workflow in Draft until its test returns HTTP 202 with accepted true.
```

## CC 02 — Submit Manual Call Outcome to HAWK

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 02 - Submit Manual Call Outcome to HAWK". Its purpose is only to submit the completed Manual Call outcome to the HAWK outcome router.

Preserve the existing cc-outcome-submit trigger, enrollment settings, and working HAWK webhook connection exactly as configured. Do not recreate or replace the trigger or Webhook action. Locate the existing Webhook action named "Submit Call Outcome to HAWK" and preserve its current POST URL, Authorization header, secret, and standard contact-data setting. Only edit its Custom Data mappings as described below.

Under Custom Data add exactly these keys and values:
- eventName: fixed text call_center.outcome
- contactId: native Contact ID merge field
- name: native Contact Full Name merge field
- callOutcome: contact custom field Call_outcome, field ID IfwpWY8S2SPsrvefs72j
- nextCallAt: contact custom field CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG
- servicePool: contact custom field service_type, field ID 04r14svrWH36Knji7YcY

Use GoHighLevel's field picker for every dynamic value. Do not type field names or example values as literals. Do not remove cc-outcome-submit and do not clear Call_outcome in this workflow; HAWK performs those mutations after accepting and recording the event. Do not add delays, AI actions, custom code, communications, or Manual Call actions. Leave the workflow in Draft until its test returns HTTP 202 with accepted true.
```

## CC 10 — Roofing Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 10 - Roofing Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-roofing. Require the contact to also have hawk-dialer-ready. Exclude enrollment when the contact has cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Roofing Power Dialer Call". Set Assign To User to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly. Do not use the contact owner, a fixed user, round robin, or assignment branches in GHL; HAWK has already selected and written the dialer before adding this pool tag. After the Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set contact custom field Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, the representative must also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark the contact invalid (not dialable). Do not add automated calls, SMS, email, AI, custom code, or another Manual Call action.
```

## CC 11 — Mold Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 11 - Mold Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-mold. Require hawk-dialer-ready. Exclude contacts with cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Mold Power Dialer Call", with Assign To User set to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly; do not use the owner, a fixed user, or GHL assignment logic because HAWK has already assigned the dialer. After that Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark invalid. Do not add automated communications, AI, custom code, or another call action.
```

## CC 12 — Solar Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 12 - Solar Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-solar. Require hawk-dialer-ready. Exclude contacts with cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Solar Power Dialer Call", with Assign To User set to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly; do not use the owner, a fixed user, or GHL assignment logic because HAWK has already assigned the dialer. After that Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark invalid. Do not add automated communications, AI, custom code, or another call action.
```

## CC 13 — Kitchen Remodel Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 13 - Kitchen Remodel Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-kitchen. Require hawk-dialer-ready. Exclude contacts with cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Kitchen Remodel Power Dialer Call", with Assign To User set to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly; do not use the owner, a fixed user, or GHL assignment logic because HAWK has already assigned the dialer. After that Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark invalid. Do not add automated communications, AI, custom code, or another call action.
```

## CC 14 — Bathroom Remodel Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 14 - Bathroom Remodel Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-bathroom. Require hawk-dialer-ready. Exclude contacts with cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Bathroom Remodel Power Dialer Call", with Assign To User set to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly; do not use the owner, a fixed user, or GHL assignment logic because HAWK has already assigned the dialer. After that Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark invalid. Do not add automated communications, AI, custom code, or another call action.
```

## CC 15 — Home Addition Power Dialer

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 15 - Home Addition Power Dialer". Trigger when Contact Tag Added includes exactly cc-pool-home-addition. Require hawk-dialer-ready. Exclude contacts with cc-dnc, cc-not-interested, cc-scheduled, cc-invalid, cc-converted-sale, cc-closed-won, cc-closed-lost, cc-dnq, or cc-dial-blocked. Disable Allow Multiple.

Locate the existing Manual Call action named "Home Addition Power Dialer Call", with Assign To User set to the contact custom value {{contact.assigned_dialer}}. Preserve that dynamic value exactly; do not use the owner, a fixed user, or GHL assignment logic because HAWK has already assigned the dialer. After that Manual Call action completes, add tag cc-outcome-submit.

Add this workflow-description instruction: before completing or deleting the Manual Call task, the representative must set Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to exactly one of: No Answer, Voicemail, Follow Up, Requested Appointment, Not Interested, Incorrect Number, or No Longer At Address. For Follow Up, also set CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. Incorrect Number and No Longer At Address mark invalid. Do not add automated communications, AI, custom code, or another call action.
```

## CC 20 — No Answer Retry Scheduler

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 20 - No Answer Retry Scheduler". Its purpose is to return a no-answer contact to HAWK for a fresh compliance and calendar decision after a controlled cooldown.

Trigger when Contact Tag Added includes exactly cc-await-retry. Allow another enrollment only after the contact has exited its prior run. Wait exactly 24 hours. Then remove cc-await-retry and add cc-recheck. End the workflow.

Do not add hawk-dialer-ready or any cc-pool-* tag directly. Do not create a Manual Call action. Do not add communications, AI, or custom code. HAWK and OWL must perform the new DNC, phone, calendar, calling-hours, and attempt-limit decision.
```

## CC 21 — Requested Callback Scheduler

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 21 - Requested Callback Scheduler". Trigger when Contact Tag Added includes exactly cc-await-callback.

Branch on contact custom field CC Next Call At, field ID HvxGHlgSy1tdJ4PLnVGG. If it is empty, remove cc-await-callback, add cc-outcome-review, and end. If it contains a date and time, wait until that exact contact date and time, then remove cc-await-callback, add cc-recheck, and end.

Do not add a pool tag, hawk-dialer-ready, or a Manual Call action directly. Do not add communications, AI, or custom code. The cc-recheck tag must cause HAWK and OWL to perform a fresh eligibility decision before another call is queued.
```

## CC 30 — Appointment Safeguard

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 30 - Appointment Safeguard". Its purpose is to remove contacts with active appointments from Power Dialer eligibility.

Trigger when an appointment is created or when an appointment status becomes New or Confirmed. Update contact custom field Call_outcome, field ID IfwpWY8S2SPsrvefs72j, to the exact stored value scheduled. Then add tag cc-outcome-submit and end.

Do not add a Manual Call action, outbound communication, AI, or custom code. HAWK will consume cc-outcome-submit, remove active queue tags, record the outcome, and mark the contact scheduled.
```

## CC 31 — DNC Safeguard

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 31 - DNC Safeguard". Trigger when contact custom field Call_outcome, field ID IfwpWY8S2SPsrvefs72j, changes to the exact stored value dnc.

Use GoHighLevel's native Do Not Disturb action to enable DND for both the Call channel and SMS channel. Then add tag cc-outcome-submit and end.

Do not add outbound communication, a Manual Call action, AI, or custom code. The outcome webhook and HAWK will remove the contact from all active calling pools and record the DNC result.
```

## CC 40 — Won Sale Queue Removal

```text
This is an edit request, not a creation request. Modify only the currently open existing GoHighLevel workflow named "CC 40 - Won Sale Queue Removal". Trigger when an opportunity changes to Won in the production sales pipeline.

Remove all of these tags from the associated contact: cc-recheck, hawk-dialer-ready, cc-pool-roofing, cc-pool-mold, cc-pool-solar, cc-pool-kitchen, cc-pool-bathroom, cc-pool-home-addition, cc-await-retry, cc-await-callback, cc-outcome-submit, cc-dial-blocked, and cc-outcome-review. Add tag cc-converted-sale (optional alias cc-closed-won). Update contact custom field Dialer Status, field ID VsXb7HofKxm6F5sr7edH, to exactly CLOSED - WON SALE. End the workflow.

Do not create another opportunity, Manual Call action, communication, AI action, or custom code. Do not add cc-recheck while the won tag remains. OWL does not write closed_won status from this flow yet; recheck skip blocks re-queue.
```


## Required operating rule

GoHighLevel's Manual Call action remains pending until the representative completes or deletes the task in **Conversations > Manual Actions**. The representative must save `Call_outcome` before completing the task. The next workflow step adds `cc-outcome-submit`, which invokes the separate HAWK outcome workflow.

### Terminal tags and re-queue hygiene

- Custom dispositions: **No Answer**, **Voicemail**, **Follow Up**, **Requested Appointment**, **Not Interested**, **Incorrect Number**, **No Longer At Address**.
- `not_interested`, `requested_appointment`/`scheduled`, and **invalid** (Incorrect Number / Wrong Number / No Longer At Address → `cc-invalid`) also write OWL lifecycle via `divedeep.apply_call_outcome`.
- Closed Won / Lost / DNQ stay **workflow-tag only** (`cc-converted-sale` / `cc-closed-won`, `cc-closed-lost`, `cc-dnq`). Do **not** re-add `cc-recheck` while any terminal tag remains (including `cc-invalid`).
- OWL recheck skips those tags server-side so “Queue missing” cannot re-signal them.
- Past appointment: remove `cc-scheduled` only when intentionally returning the contact to dial, then add `cc-recheck`.
