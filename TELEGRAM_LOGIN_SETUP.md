# Telegram Login backend

This folder contains the Cloudflare Worker for Telegram OpenID Connect login.

## Required Worker secrets

Set these in Cloudflare Worker Settings → Variables and Secrets (as **Secrets**, not plain text):

- `CLIENT_ID` — Client ID from @BotFather → Login Widget → OpenID Connect Login.
- `CLIENT_SECRET` — Client Secret from the same screen.
- `SESSION_SECRET` — a newly generated random secret of at least 32 bytes.

The non-secret variable `FRONTEND_URL` is set in `wrangler.toml` to `https://anemobe1122-alt.github.io`.

## Deploy

1. Create a Cloudflare account and open Workers & Pages.
2. Create a Worker named `online-school-telegram-auth`.
3. Upload `worker/index.js` as the Worker code (or deploy this folder with Wrangler).
4. Add the three secrets above.
5. Confirm the Worker URL is `https://online-school-telegram-auth.<your-subdomain>.workers.dev`.
6. Check `https://...workers.dev/health` returns `{"ok":true,"service":"telegram-login"}`.

## BotFather URLs

Only after the Worker is deployed, register these in @BotFather → your bot → Login Widget → OpenID Connect Login:

- Redirect URI: `https://online-school-telegram-auth.<your-subdomain>.workers.dev/auth/callback`
- Trusted Origin: `https://anemobe1122-alt.github.io`

Replace `<your-subdomain>` with the actual Cloudflare Workers subdomain.

## Security notes

- Never put `CLIENT_SECRET` or `SESSION_SECRET` in the public GitHub repository or browser code.
- The Worker uses Authorization Code Flow with PKCE, validates Telegram's RS256 ID-token signature and claims, and issues a short-lived signed session.
- The browser session token is returned in the URL fragment so it is not sent in HTTP requests or referrer headers. The site must move it to `sessionStorage` and immediately remove the fragment.
- This first version authenticates the Telegram identity but does not yet persist course progress or homework. Add a database before treating the cabinet as a full student-record system.
