# GHL single Manual Call receiver for HAWK

This replaces the six `cc-pool-*` Manual Call enrollment workflows. Pause **CC 10 through CC 15** before publishing this receiver so one contact cannot receive duplicate Manual Call tasks.

## One-time manual trigger setup

1. In one GoHighLevel workflow, add an **Inbound Webhook** trigger and copy its generated URL.
2. In the HAWK flow **Call Center - OWL Eligibility and Pool Routing**, edit **Send Manual Call request** and replace its placeholder URL with that GHL URL.
3. Send a HAWK test execution. In the GHL trigger, fetch the sample and select the request containing `eventName=call_center.manual_call`.
4. Add **Find Contact** immediately after the trigger. Match the native Contact ID field to the inbound webhook body value `contactId`. Use `email` or `phone` only as a secondary recovery match; never create a duplicate contact.
5. On **Contact Found**, add one **Manual Call** action. Set **Assign To User** to the contact custom value `{{contact.assigned_dialer}}`.
6. After the Manual Call action completes, add tag `cc-outcome-submit` so the existing outcome workflow posts back to HAWK.
7. On **Contact Not Found**, end the branch without creating a call task.

The Find Contact step is the contact-context bridge required by a contactless inbound webhook. It contains no assignment or pool logic. The only queue/business action in GHL is Manual Call.

## Workflow AI edit prompt

```text
This is an in-place edit request. Modify only the currently open GoHighLevel workflow. Do not create, clone, duplicate, or rename a workflow.

Preserve the currently configured Inbound Webhook trigger and its generated URL. The trigger receives a JSON object with eventName, contactId, name, email, phone, and servicePool. Preserve the mapping reference whose eventName is call_center.manual_call.

Remove all tag-triggered pool routing, service branches, round-robin logic, owner assignment logic, fixed-user assignment, AI actions, messages, delays, and extra Manual Call actions from this workflow.

Immediately after the Inbound Webhook trigger, keep exactly one Find Contact action. Configure its primary match as native Contact ID equals the Inbound Webhook body value contactId. If the editor supports fallback matching, use inbound email and then inbound phone only as fallback identifiers. Do not create a new contact when no match is found.

On the Contact Found path, keep exactly one Manual Call action named "HAWK Power Dialer Call". Set Assign To User to the existing contact custom value {{contact.assigned_dialer}}. This must be inserted with the GoHighLevel custom-value picker, not typed as a fixed user. HAWK has already applied existing-dialer, record-owner, OWL round-robin, and pool-fallback assignment logic before sending this webhook.

Immediately after the Manual Call action completes, add tag cc-outcome-submit. On Contact Not Found, end without creating a task. Do not add any other business action. In Workflow Settings, enable Allow Re-entry. HighLevel will not re-enter a contact while its current Manual Call execution is still active, but callbacks and later retries can re-enter after the prior execution completes or is removed. Save as Draft for testing.
```

## Expected HAWK payload

```json
{
  "eventName": "call_center.manual_call",
  "contactId": "GHL_CONTACT_ID",
  "name": "Contact name",
  "email": "contact@example.com",
  "phone": "+15555550100",
  "servicePool": "roofing"
}
```
