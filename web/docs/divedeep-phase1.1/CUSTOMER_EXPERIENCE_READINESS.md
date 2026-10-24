# Customer Experience Readiness

Phase 1.1 prepares the API for a live-feeling customer experience without modifying the current frontend.

## Analysis wall

The presentation contract supports a rotating stream of protected thumbnails while work is underway:

- Thumbnail artifact reference only
- Blur enabled by default
- Configured blur strength
- Safe progress percentage
- Safe status language
- No raw provider response
- No private source details
- No unreviewed identity claim

Suggested customer-facing phases:

- Discovering candidate imagery
- Comparing authorized references
- Validating context
- Human review in progress
- Your confirmation requested
- Confirmation received

## Reviewer escalation

A reviewer may:

- Confirm a candidate
- Reject a candidate
- Request customer validation
- Publish a validated result through the later evidence workflow

Customer validation is not a substitute for review. It is a protected escalation path for a candidate that appears plausible but does not meet the reviewer's standard for confirmation.

## Privacy defaults

- Blurred thumbnail stream enabled
- Human validation required
- Raw provider data excluded from customer responses
- Confirmed/rejected status shown without exposing internal scores
- Rejected candidate scheduled for 24-hour expiration
- Pending customer validation scheduled for 30-day disposition
