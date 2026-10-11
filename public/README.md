# ProGuard Security Dashboard

A responsive dashboard frontend for the ProGuard Discord security project.

## Files
- `index.html` — page structure and dashboard views
- `style.css` — responsive dark/glass interface
- `script.js` — navigation, API client, report/case workflows, analytics rendering, and session UI

## Existing service
The frontend is configured to use the existing Cloudflare Worker:

`https://proguard.guardianpro.workers.dev`

Discord login begins at `/auth/discord`; preserve the existing callback `/auth/discord/callback`.

## API contract expected by this frontend
The Worker should expose JSON endpoints with session cookies (`credentials: include`):

- `GET /api/me` — `{ user: { id, username, global_name, avatar }, isOwner: boolean, services?: { firebase, worker } }`
- `GET /api/overview?range=7d|24h|30d` — metric totals plus `activity: [{ label, events, resolved }]`
- `GET /api/reports` — array of report records or `{ items: [...] }`
- `POST /api/reports/:id/action` — `{ action, status, priority, notes }`
- `GET /api/cases` — array of case records or `{ items: [...] }`
- `POST /api/cases/:id/action` — `{ action: "update", status, notes }`
- `GET /api/analytics?range=7d|24h|30d` — totals, `activity`, and `breakdown`
- `GET /api/bot/status` — bot heartbeat/status, latency, guild count, version
- `GET /api/admin/audit` — owner-only audit entries
- `POST /auth/logout` — clear the server-side session

This frontend deliberately does not pretend those endpoints already exist. If a route is missing or the API cannot be reached, the dashboard displays a connection warning instead of fabricated live metrics.

## Deployment
Upload the three frontend files to your chosen static host. For Cloudflare Pages, create a project and upload/deploy this folder. The API stays on the existing Worker. If the frontend is hosted on a different origin, configure appropriate CORS headers on the Worker for that exact origin and allow credentials; do not use `Access-Control-Allow-Origin: *` with cookies.

## Required security notes
- Keep `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, Firebase service-account credentials, and other private keys on the server only.
- Enforce owner/moderator permissions in the Worker for every private endpoint. Hiding owner controls in the browser is not authorization.
- Validate report IDs and action payloads server-side, check CSRF protections for cookie-authenticated mutations, and write privileged actions to the audit log.
- Do not add bot start/stop controls until a secure, authenticated Wispbyte control mechanism exists.
