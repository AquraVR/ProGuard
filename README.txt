PROGUARD WEBSITE FRONTEND

Files:
- index.html: landing page and dashboard preview
- style.css: responsive dark security-themed design
- app.js: small browser-side behavior

IMPORTANT
This package is the visual frontend only. The dashboard preview deliberately uses placeholder data. Discord sign-in buttons point to /auth/discord, which must be implemented by your existing Cloudflare Worker. Uploading these three files alone does not implement OAuth, protect owner-only actions, or connect Firebase.


Do not put Discord bot tokens, Discord client secrets, Firebase service-account JSON, or other private credentials in these frontend files.

The existing Worker should keep its /auth/discord and /auth/discord/callback routes. Configure it to serve these static assets without removing those routes. If you instead deploy this folder as a separate static site, update the sign-in links to point to the Worker URL's /auth/discord route and add that site's URL to the appropriate Discord OAuth settings only if needed.
