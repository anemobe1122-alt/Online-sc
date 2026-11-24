# Telegram registration for students

The site stays on GitHub Pages. The Telegram registration runs in a Cloudflare Worker and saves student accounts in Cloudflare D1. The existing pages and the existing `/auth/*` Worker routes are left in place. The current site has no registration or login form wired into its HTML.

## What a student does

1. On the site, open **Курсы → Мои курсы** and select **Зарегистрироваться через Telegram**.
2. Open the one-time link to `@OnlineSchoolOgBot` and press **Запустить**.
3. The bot webhook confirms the Telegram account. The Worker creates (or recognizes) the student row in D1 and the site saves a signed, seven-day session in `sessionStorage`.

Registration links expire after 10 minutes. The browser keeps a separate polling secret; only its hash is stored in D1. The webhook uses Telegram's secret-token header. Keep all three secrets below out of GitHub and browser code.

## Cloudflare setup (required before registration works)

Run these commands from the repository root with Wrangler logged in:

```powershell
npx wrangler d1 create online-school-students
```

Copy the returned database ID into `database_id` in `wrangler.toml`, replacing `REPLACE_WITH_DATABASE_ID`. Then create the tables and deploy:

```powershell
npx wrangler d1 migrations apply online-school-students --remote
npx wrangler deploy
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

The first deploy creates the Worker so Wrangler can attach its secrets. Wrangler prompts for each secret. `BOT_TOKEN` is the token for `@OnlineSchoolOgBot` from BotFather. Make `WEBHOOK_SECRET` a random string containing only letters, digits, `_` or `-` (at least 32 characters). Make `SESSION_SECRET` a different random secret with at least 32 bytes. Do not reuse the bot token as either secret. The last deploy publishes the configured Worker version.

After deployment, note the Worker URL Wrangler prints, for example `https://online-school-telegram-auth.<your-subdomain>.workers.dev`. Set the bot webhook using the same Worker URL and webhook secret. In PowerShell, with the bot token and webhook secret held in environment variables:

```powershell
$body = @{
  url = "https://online-school-telegram-auth.<your-subdomain>.workers.dev/telegram/webhook"
  secret_token = $env:TELEGRAM_WEBHOOK_SECRET
  allowed_updates = @("message")
} | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$($env:TELEGRAM_BOT_TOKEN)/setWebhook" -ContentType "application/json" -Body $body
```

The result should contain `"ok": true`. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in the PowerShell session from your secret store before running that command. Do not paste real values into this file or commit them.

## Connect the GitHub Pages site

Replace `YOUR_SUBDOMAIN` in the `TELEGRAM_AUTH_API` constant in `index.html` with the Worker subdomain Wrangler assigned. The site is published by the existing GitHub Pages workflow; pushing this HTML change to `main` will publish it there. The expected project Pages URL is `https://anemobe1122-alt.github.io/Online-sc/`; `FRONTEND_URL` in `wrangler.toml` must remain the origin only (`https://anemobe1122-alt.github.io`) because browsers do not send a path in the `Origin` header.

Check `https://<your-worker-host>/health` returns `{"ok":true,"service":"telegram-login"}`. If Cloudflare assigns a different Worker host, use that exact host both in the bot webhook URL and the site's `TELEGRAM_AUTH_API` value.

## Student data

The `students` table stores Telegram user ID, first name, username (when public), and account creation time. Do not add school records or sensitive student information here without first defining the required access controls, retention, and privacy notice. This minimal registration stores no course progress or homework.

