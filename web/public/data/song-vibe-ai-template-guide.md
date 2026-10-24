# SONG JSON template rules for AI

Return one valid JSON object only. Do not wrap it in Markdown and do not include comments.

## Required root

- `templateVersion` must be `song-vibe-1`.
- `services` must contain 1-50 service objects.
- Each service requires `serviceType`, `mainScript`, `concerns`, and `outcomes`.
- Set `languageCode` to a valid BCP 47 tag such as `en-US` or `es-US`; omitted values default to `en-US`.

## Stage contract

Use these exact `mainScript` keys: `identity`, `reason`, `address`, `diagnosis`, `trust`, `appointment`, `confirmation`, and optional `wrapUp`.

Every stage must be an object:

```json
{
  "text": "Exact wording spoken by the agent",
  "type": "question",
  "helperText": "Optional private guidance for the agent",
  "answers": []
}
```

`text`, `helperText`, `response`, and `negativePathText` must always be JSON strings. Never place an object or array in a wording field. This prevents `[object Object]` from appearing in SONG.

## Answer contract

- `id`: unique stable ID beginning with a letter; letters, numbers, `_`, and `-` only.
- `label`: short button label.
- `action`: one of `proceed`, `show_negative_path`, `book_appointment`, or `jump_to_stage`.
- `response` or `agentResponse`: optional wording spoken after selection and before the next stage.
- `show_negative_path` requires `negativePathText` and `negativePathOutcome`.
- `jump_to_stage` requires `targetStage`.
- Use no more than 12 answers per stage.

## Concern contract

Each concern requires `id`, `label`, `response`, and `action`. Actions are `proceed`, `end_call`, or `jump_to_stage`. A jump requires `targetStage`.

## Supported placeholders

- `{getGreeting()}` becomes `{{dynamicGreeting}}`.
- `{contact.firstName}` becomes `{{firstName}}`.
- `{contact.city}` becomes `{{city}}`.
- `{contact.state}` becomes `{{state}}`.
- `{contact.address}` becomes `{{serviceAddress}}`.
- `{agent.firstName}` becomes `{{agentName}}`.
- `{selectedService}` becomes `{{serviceType}}`.
- `{currentServiceData.reason}` is replaced with the service's `reason` string.

Do not invent JavaScript expressions, JSX, functions, HTML, credentials, API keys, or CRM payloads. Do not use placeholders outside this list unless the matching SONG variable is separately declared after import.

## Quality rules

- Write concise, natural spoken language rather than marketing copy.
- Give every reachable choice a valid next action.
- Include explicit opt-out and wrong-person paths.
- Keep `response` for words the agent should say, not implementation instructions.
- Put implementation instructions in `helperText`.
- Do not auto-publish; imports are editable drafts.
- Validate against `/data/song-vibe-import.schema.json` before returning the JSON.
