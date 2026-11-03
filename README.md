# Alex Pizza — AI Calling Agent

Production codebase for the Alex Pizza New York inbound voice agent.

## Deployment

Cloudflare Workers Builds should deploy the `main` branch after the production implementation and deployment configuration are committed.

## Runtime

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Workflows
- Vapi inbound voice tools
- Zoho POS integration

## Tenant

- Tenant ID: `alex-pizza`
- Business timezone: `America/New_York`
- Business hours: 12:00 PM–2:00 AM

Production implementation and migrations will be committed together after the integrated code review. Existing D1 menu records must be preserved.
