# Environment Separation Checklist

Produce complete `.env` files for development, staging, and production in a secure location. Do not place them in this source tree.

Run:

```bash
npm run divedeep:environment-compare -- /secure/development.env /secure/staging.env /secure/production.env
```

The comparison requires unique deployment IDs, instance IDs, database names, storage namespaces, customer origins, and API origins. Production must include its acknowledgement and closed CORS configuration.

Secrets must also be unique even though the comparison tool deliberately does not read or print them:

- session secret
- secret-box key
- forensic key
- worker token secret
- database credential
- OAuth client
- GHL webhook secret
- object-storage credential or role
