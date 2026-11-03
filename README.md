# Alex Pizza Voice Agent Worker

Cloudflare Worker + D1 + Cloudflare Workflows integration for the Alex Pizza Vapi voice agent.

**Current state: staging candidate only.** This build has not been committed to the production branch or deployed. See [Urdu setup and behavior notes](README_UR.md).

## Project files
- `src/index.js` — Worker module and `OrderProcessingWorkflow` class.
- `wrangler.toml` — Worker, D1 binding, Workflow binding, and daily maintenance cron.
- `D1_PREDEPLOY_CHECKS.sql` — read-only checks for the existing D1 database.
- `verify-build.mjs` — local smoke tests for business hours, menu compatibility, reservation capacity, tool registry, and safety guards.

## Local checks
```bash
node --input-type=module --check < src/index.js
node verify-build.mjs
```

## Deployment
The Cloudflare Workers Builds deploy command is `npx wrangler deploy`. Keep the Build command empty for this plain JavaScript Worker. Do not deploy until the existing D1 menu, runtime secrets, Workflow binding, and Zoho item mappings have been verified.