# ProGuard dashboard: files, setup and test report

## Files
- `worker.js`: the Cloudflare Worker. Discord sign-in, signed server-side sessions, owner-only API, Firestore bridge, bot command queue.
- `wrangler.jsonc`: Worker config. Replaces your existing one. Keep the name `proguard`.
- `public/`: the dashboard (`index.html`, `style.css`, `script.js`). Same design as before, with the Settings page and the owner panel corrected.
- `bot.py`: your bot with the dashboard bridge added. Changes: a 60-second heartbeat, a command queue, report posts to a channel, and case status. Nothing else was changed except the `__main__` guard around `bot.run`.
- `tests/`: automated tests (Worker, bot bridge, page). Run with `node --test tests/worker.test.mjs`, `python3 tests/test_bot_bridge.py`, and for the page `npm i jsdom@24` then `node --test tests/dom.test.mjs` in `tests/`.

## 1. Discord (Developer Portal)
- OAuth2 → Redirects: add `https://proguard.guardianpro.workers.dev/auth/discord/callback`.
- Reset the client secret if the old one was shared anywhere. The old Worker file had it in plain text.
- Bot invite. `redirect_uri` is not needed for a bot install, so it is removed:
  `https://discord.com/oauth2/authorize?client_id=1558816067948642455&permissions=8&integration_type=0&scope=bot+applications.commands`

## 2. Firebase (project `proguarddb`)
- Create a service account with the role **Cloud Datastore User**. Download its JSON key. Do not send it to anyone.
- Firestore rules: the browser never reads Firestore, so deny all client access:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```
- Indexes: if the Worker logs `FAILED_PRECONDITION` with a link, open the link and create the index. It is expected for the analytics "resolved in range" count (reports: `status` ascending, `created_at` ascending).

## 3. Cloudflare Worker
- Secrets (Settings → Variables and Secrets, type Secret):
  - `DISCORD_CLIENT_SECRET`: the client secret from step 1.
  - `SESSION_SECRET`: a new random string of 64 or more characters.
  - `FIREBASE_SERVICE_ACCOUNT_JSON`: the whole service-account JSON file.
  - `DISCORD_BOT_TOKEN`: the bot token. The Worker uses it only to check bot installation and list text channels.
- Plain variables come from `wrangler.jsonc`: client ID, redirect URI, owner ID, project ID.
- Deploy: `npx wrangler deploy` in this folder. Or upload the Worker code and the `public/` folder in the dashboard.
- Recommended: add a Cloudflare Rate Limiting rule for `/auth/*` and `/api/*`. The in-Worker limit is best effort.

## 4. Wispbyte bot
- Replace `bot.py` with the new file. Keep your `.env` and the Firebase credentials file as they are.
- Restart the bot. Within about a minute the `bot_status/current` document appears and the dashboard shows ONLINE.
- Start it as before. `bot.run` now sits under `if __name__ == "__main__":`.

## 5. Security model
- Only the Discord user ID in `OWNER_DISCORD_ID` gets a session. Everyone else is refused and the attempt is written to the audit log.
- Sessions are random IDs stored in Firestore. The cookie is HMAC-signed, HttpOnly, Secure and SameSite=Lax. Logout deletes the session on the server.
- OAuth `state` is signed and checked on callback. The Discord access token is revoked after sign-in and never stored.
- Every API route checks the session on the server. Any server ID is checked against the signed-in owner's manageable servers, so changing `guild_id` cannot reach another server.
- POST routes need the `X-ProGuard-Request` header and a matching `Origin`. This blocks cross-site form submissions.
- Sensitive actions write to `audit_log` first. If the audit write fails, the action does not run.
- The bot only runs queued commands requested by `OWNER_DISCORD_ID`, and only in servers it is in.
- Secrets never reach the browser. Error responses do not include internal details.

## 6. Test report
- Worker, 23 of 23 passed, against simulated Google, Firestore and Discord endpoints. This covers: unauthenticated access, non-owner sign-in refused, cross-server access, CSRF, invalid IDs and bodies, fail-closed audit, logout, tampered cookies, the service-account JWT signature checked with an RSA key, and security headers.
- Bot bridge, 12 of 12 passed, with Firestore and Discord stubbed. This covers: refusal of non-owner commands, servers the bot is not in, unknown and malformed commands, the heartbeat payload, and the report embed.
- Page, 5 of 5 passed in jsdom, loading the real `index.html` and `script.js`. This covers: signed-out state, owner data and scoping, the server picker, analytics rendering, and the owner-page guard.
- Not tested, because it needs your accounts: real Discord sign-in, real Firestore reads and writes, the Wispbyte process, and bot commands executing in a live server.

## 7. Live checklist after deploy
1. Open the site and sign in as the owner. The server list should show your server with "Bot installed".
2. Sign in with a second Discord account, if you have one. You should land on `?access=denied`.
3. Restart the bot. Within a minute the status should be ONLINE. Stop it, and after about 3 minutes it should show STALE.
4. Server settings: choose a log channel, save, then press Send test message. It should report Done and the message should appear in that channel.
5. In Discord, run `/report`. It should appear under Reports and be posted in the report channel. Resolve it on the site. The embed in Discord should update.
6. Run `/warn` on a test account. A case should appear under Cases. Change its status and check the audit log.

## 8. Known limits
- Counts are exact. Charts sample up to 2,000 recent events and lists show the newest 200. When a sample is capped the response says `truncated`.
- The only bot command you can send from the site is "send test message". Ban, role and channel actions are deliberately not exposed. To add one, put it in the allow-list in `worker.js` and add a handler in `bot.py`.
- A session lasts 12 hours. Server access is captured at sign-in, so sign in again after changing permissions.
- Email is requested and stored with the session. Authorization uses your Discord user ID, which is stronger than email. Tell me if you want the email scope removed.
- Cases created before this update show the status "recorded". Reports created before this update show priority "medium".
- The rate limiter lives in each Worker instance. Use the Cloudflare rule for real protection.
