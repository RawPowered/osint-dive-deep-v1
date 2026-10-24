# Quick Recon

Quick Recon is DiveDeep's single-target entry point. It reduces setup when the analyst needs one exact lookup while preserving case evidence and access to the full workflow.

## Supported targets

- Address or latitude/longitude
- Email, domain, IP address or URL
- Username or phone number
- Person or organization
- Parcel identifier

DiveDeep detects the likely type and keeps the type editable. The normalized value, original input, chosen depth and selected source steps are stored with the run.

## Run flow

1. Open **Quick Recon** from the sidebar.
2. Enter one exact target and confirm its detected type.
3. Choose Fast, Standard or Deep and keep only the relevant source steps.
4. Save to the active case or let DiveDeep create a scratch case.
5. Use Automatic routing or select Discovery, Web Validation, Tool Arsenal, People Command Center or Property Explorer.

Automatic routing keeps the shortest useful path:

- Addresses, coordinates and parcels open Property Explorer.
- People open the People & Identity Command Center.
- URLs open Web Validation.
- Other technical and identity targets open Discovery.

Coordinates become the current map selection without rebuilding the base map. An address can be resolved through the free U.S. Census Geocoder on demand; the exact response is archived as case evidence. Parcel targets retain the exact identifier and expose the appropriate official property-source entry points.

## Full Hunt bridge

**Promote last target to Full Hunt** preserves the target and case, changes the depth to Deep, and routes it to the appropriate existing command center. Quick Recon does not replace a Full Hunt; it removes repeated intake and setup.

## Case behavior

Every launch records a subject, normalized identifier, selected source pack, routing observation and completed run. Derived domains from URLs and emails are stored as linked identifiers. Scratch cases appear in the normal Case Workspace and can be renamed, completed or archived there.
