# Unified Property, Owner and Market Report

The Unified Report is the fast review surface for a selected property. It keeps these evidence lanes together without flattening unlike claims into one inferred person profile:

1. **Property facts** - address, parcel, county, owner of record, property type, year built, permit authority and storm exposure.
2. **Owner corroboration** - manual, single-record name/address checks with source, result, confidence and suppression state.
3. **Language evidence** - self-declared, consent-recorded or observed public-profile language with exact source URL and confidence.
4. **Area market context** - 2024 ACS 5-year county aggregate population, languages, race/ethnicity composition and household-income distribution.
5. **Unified JSON** - one export containing the property, allowed owner-verification outcomes, language evidence and labeled aggregate market profile.

## Workflow

1. Ingest or geofence property records so owner of record and situs address are available.
2. Open **Unified Report** and build the local owner-verification queue. This action performs no external requests.
3. Open one source for one selected record, review it manually and save only the name/address outcome.
4. If an identity-matched public profile explicitly demonstrates a language, save the language, evidence basis, exact URL and confidence.
5. Configure `OSINT_CENSUS_API_KEY` under **API Keys** and refresh ACS market context.
6. Download the selected property's unified JSON report.

## Claim boundaries

- Florida Residents Directory is manual-only because its current terms prohibit automated access and significant archiving.
- National Public Data is manual-only until its permitted reuse terms can be verified.
- No CAPTCHA, authentication or private-profile controls are bypassed.
- Public-profile language is evidence about observed profile content, not proof of preferred outreach language.
- Race/ethnicity and income stay attached to the named Census geography and vintage. They are not assigned to an owner, household or address.
- Property opportunity scoring does not use demographic or language fields.
- Provider reports can later be imported as provider-supplied claims and compared field by field; they are not silently promoted to verified facts.
