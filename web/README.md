# OSINT Dive Deep v1 — Web Platform

This component contains the Node API, customer frontend, administrator interface, schema 64, and cloud-worker orchestration. Start with the [complete-stack setup](../docs/SETUP.md) and [architecture](../docs/ARCHITECTURE.md).

Run `npm ci` and `npm start`. Configure a new MySQL installation and your own secrets through the installer or protected environment. For local development use `NODE_ENV=development`, `HOST=127.0.0.1`, `COOKIE_SECURE=false`; production security and environment-separation checks remain enabled.

Run `npm test` for the main contract suite and `npm run test:extended` for the available extended tests. These do not prove a live cloud deployment or provider account is configured.
