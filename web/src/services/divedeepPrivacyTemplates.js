const TEMPLATES = [
  {
    key: 'marketing-suppression',
    label: 'Marketing suppression / unsubscribe',
    category: 'Marketing',
    subject: 'Marketing suppression request — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. I am requesting that you stop using the personal information listed below for direct marketing and suppress it from future marketing imports or campaigns.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Listing or source URL: {profile_url}

Requested action:
{request_actions}

You may retain only the minimum suppression information necessary to ensure this person is not re-added, where permitted. {legal_basis}

Please confirm completion or explain any information you must retain and why. Please use case reference {case_reference} in your response.

Regards,
{requester_name}
{requester_email}`,
    description: 'Stops campaign use while allowing a minimal suppression marker to prevent re-import.',
  },
  {
    key: 'data-broker-deletion',
    label: 'Data broker deletion + sale/share opt-out',
    category: 'Data broker',
    subject: 'Delete and opt-out request — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. Please delete personal information associated with the subject below and opt the subject out of the sale or sharing of personal information, where applicable.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Profile/listing URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

This request includes public-facing records, profiles, derived attributes and inferences controlled by your organization, subject to lawful exceptions. {legal_basis}

Please confirm the action taken, identify any data you cannot delete and the reason for retaining it, and provide a confirmation or reference number. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'Requests deletion plus opt-out without claiming that every record is legally erasable.',
  },
  {
    key: 'people-search-removal',
    label: 'People-search profile removal',
    category: 'People search',
    subject: 'Remove public profile — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. Please remove or suppress the public profile and search result identified below from your site and from future publication under the same identity.

Subject: {subject_name}
Profile URL: {profile_url}
Listing ID: {listing_identifier}
Related identifier: {subject_email_or_identifier}

Requested action:
{request_actions}

Please also remove controlled thumbnails, snippets and cached copies that reproduce the listing, where applicable. {legal_basis}

Please confirm completion or provide the exact verification step required. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'For people-search and directory listings selected and reviewed by the operator.',
  },
  {
    key: 'b2b-contact-removal',
    label: 'B2B lead/contact removal',
    category: 'B2B lead data',
    subject: 'Remove business contact record — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. Please remove the subject's personal contact record from your lead, enrichment, prospecting and audience products.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Record URL: {profile_url}

Requested action:
{request_actions}

Please propagate the suppression to controlled marketing products and future imports where applicable. {legal_basis}

Please confirm completion and provide a reference number. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'For personal data appearing in lead, enrichment and prospecting products.',
  },
  {
    key: 'account-deletion',
    label: 'Account/profile deletion',
    category: 'Account',
    subject: 'Account deletion request — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. Please close the identified account and delete the associated personal information, subject to records you are legally required to retain.

Subject: {subject_name}
Account or profile: {profile_url}
Account identifier: {subject_email_or_identifier}

Requested action:
{request_actions}

{legal_basis}

Please confirm completion and explain any retention that remains. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'Closes an account and requests deletion while recognizing mandatory retention.',
  },
  {
    key: 'correction',
    label: 'Correction / rectification',
    category: 'Correction',
    subject: 'Correct personal information — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. The record below contains inaccurate personal information. Please correct it as specified.

Subject: {subject_name}
Record URL: {profile_url}
Listing ID: {listing_identifier}

Corrections requested:
{request_actions}

{legal_basis}

Please confirm the corrected fields or explain what additional verification is required. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'Corrects an inaccurate listing rather than deleting it.',
  },
  {
    key: 'access',
    label: 'Access / know request',
    category: 'Access',
    subject: 'Personal information access request — {case_reference}',
    body: `Hello {company_name} Privacy Team,

I am {requester_statement}. Please provide the personal information associated with the subject below, the categories of sources, the purposes of use, and the categories of recipients or buyers, where applicable.

Subject: {subject_name}
Email or identifier: {subject_email_or_identifier}
Record URL: {profile_url}

Requested scope:
{request_actions}

{legal_basis}

Please provide a secure verification and delivery method. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'Requests access and provenance before deciding on correction or deletion.',
  },
  {
    key: 'adult-profile-removal',
    label: 'Adult-industry profile/content delisting',
    category: 'Adult platform',
    subject: 'Authorized privacy and delisting request — {case_reference}',
    body: `Hello {company_name} Trust, Safety or Privacy Team,

I am {requester_statement}. Please remove or de-index the authorized subject's public profile and the specific URLs listed below from services controlled by your organization.

Subject or stage name: {subject_name}
URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

Do not require intimate media to be sent by email. Please provide a secure verification channel if identity or authorization must be confirmed. This request does not ask you to destroy records you are legally required to retain. {legal_basis}

Please preserve only the minimum incident and compliance information required and confirm the public-facing removal. Reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'URL-only removal request; DiveDeep never stores or attaches intimate media.',
  },
  {
    key: 'adult-ncii-report',
    label: 'Adult non-consensual intimate content report',
    category: 'Adult safety',
    subject: 'Urgent non-consensual intimate content report — {case_reference}',
    body: `Hello {company_name} Trust and Safety Team,

I am {requester_statement}. I am reporting the following URL as containing or facilitating non-consensual intimate content involving the adult subject.

Subject: {subject_name}
URL: {profile_url}
Listing ID: {listing_identifier}

Requested action:
{request_actions}

Please remove access to the reported material, stop further controlled distribution, and preserve only the incident evidence needed for safety, appeals and legal obligations. Do not request intimate media by ordinary email; provide a secure verification channel if needed. {legal_basis}

Please confirm receipt and provide an incident reference. Case reference: {case_reference}.

Regards,
{requester_name}
{requester_email}`,
    description: 'Urgent URL-only report for an adult; pair with StopNCII where appropriate.',
  },
];

const LEGAL_BASIS_PRESETS = {
  'plain-language': 'I am making this request under applicable privacy and direct-marketing rules.',
  'california-ccpa-cpra': 'I request applicable deletion, correction, access and/or opt-out rights under the California Consumer Privacy Act, as amended, subject to lawful exceptions.',
  'eu-gdpr': 'I exercise applicable rights of access, rectification, erasure and/or objection to direct marketing under the GDPR, subject to lawful exceptions.',
  'uk-gdpr': 'I exercise applicable rights of access, rectification, erasure and/or objection to direct marketing under UK data protection law, subject to lawful exceptions.',
  custom: '',
};

const TEMPLATE_BY_KEY = Object.fromEntries(TEMPLATES.map((template) => [template.key, template]));

function renderTemplate(templateKey, values = {}) {
  const template = TEMPLATE_BY_KEY[templateKey];
  if (!template) throw Object.assign(new Error('Unknown privacy request template'), { status: 400, code: 'DIVEDEEP_TEMPLATE_UNKNOWN' });
  const replace = (input) => String(input).replace(/\{([a-z0-9_]+)\}/gi, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    return String(values[key] == null ? '' : values[key]).trim();
  });
  return { subject: replace(template.subject), body: replace(template.body), template };
}

function templateCatalog() {
  return TEMPLATES.map(({ body, subject, ...template }) => ({ ...template, subjectPattern: subject }));
}

module.exports = {
  TEMPLATES,
  TEMPLATE_BY_KEY,
  LEGAL_BASIS_PRESETS,
  renderTemplate,
  templateCatalog,
};
