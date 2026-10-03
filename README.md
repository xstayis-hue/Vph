# Vph

Vph is a Telegram Mini App backed by a small Node.js service. Subscription state is stored server-side; a successful payment is verified by its provider before a user is created or renewed in Marzban.

## Payment rules

- The Telegram Mini App accepts Telegram Stars (`XTR`) only. Telegram requires Stars for digital services sold inside bots and Mini Apps.
- Crypto Pay (`USDT`) is served on a separate HTTPS host configured as `CRYPTO_BASE_URL`. It is intentionally not linked from the Telegram Mini App.
- External checkout uses an HttpOnly browser session cookie so repeat purchases renew the same VPN account.
- Users must actively check the unchecked terms-acceptance box before each checkout. Consent version and timestamp are recorded with the order.
- Neither payment method is enabled until the bot, payment prices, HTTPS URLs, operator details, support contact, and Marzban connection are configured.

## What you need

- Node.js 24 or Docker on a public server.
- Two DNS names pointing to the server: one for the Telegram Mini App (`BASE_HOST`) and a different one for external crypto checkout (`CRYPTO_HOST`).
- A Telegram bot configured to launch the Mini App at `BASE_URL`.
- A reachable Marzban panel with an enabled inbound. The inbound protocol and exact tag must match `VPH_PROTOCOL` and `VPH_INBOUND_TAG`.
- For Stars: the bot token, Telegram webhook secret, and integer Stars prices.
- For Stars support: a public support contact configured as `VPH_SUPPORT_CONTACT`; the bot responds to `/paysupport`.
- Operator name and contact email (`VPH_OPERATOR_NAME`, `VPH_OPERATOR_EMAIL`), plus a support contact. Checkout remains disabled until these are set.
- A terms page at `BASE_URL/terms.html` is included as a Russian-language starting draft. Review it with a qualified Russian lawyer, complete operator details, and update `VPH_TERMS_VERSION` whenever the text changes. `VPH_TERMS_URL` may override the default page URL.
- For external crypto: a Crypto Pay API token, configured Crypto Pay webhook, and USDT prices.

Do not paste bot, Marzban, or Crypto Pay secrets into source files or chat. Keep them in `.env` on the server.

## Configure

1. Copy `.env.example` to `.env`.
2. Set `BASE_HOST`, `CRYPTO_HOST`, `BASE_URL`, and `CRYPTO_BASE_URL`. The two URL hosts must be different and use HTTPS in production.
3. Set the bot token and a random `TELEGRAM_WEBHOOK_SECRET` (1–256 characters; Telegram permits letters, digits, `_`, and `-`).
4. Set `VPH_SUPPORT_CONTACT`, `VPH_OPERATOR_NAME`, and `VPH_OPERATOR_EMAIL` to real public business/support details. Payments stay disabled if the operator identity is missing.
5. Review `terms.html` with a qualified Russian lawyer and adapt it to the actual operator, service, and refund process. Set `VPH_TERMS_VERSION` to a new value whenever you publish a changed version.
6. Set the Marzban URL, admin credentials, protocol, and an exact inbound tag.
7. Set the actual `VPH_STARS_30`, `VPH_STARS_90`, and `VPH_STARS_180` prices as positive whole Stars. Set the external checkout prices in `VPH_USDT_*`.
8. Set `CRYPTO_PAY_TOKEN` only if you will use the external checkout. Use `CRYPTO_PAY_TESTNET=true` for a test Crypto Pay app.

For a local development server, HTTPS is not required when `NODE_ENV` is not `production`. Production URLs must use HTTPS.

## Run locally

```powershell
Copy-Item .env.example .env
npm.cmd test
npm.cmd start
```

Open `http://localhost:3000` to inspect the Mini App shell. Payment buttons remain disabled until the matching integrations and prices are configured.

## Static preview and automatic publishing

The repository already publishes its `main` branch through GitHub Pages at `https://xstayis-hue.github.io/Vph/`. Push changes to `main` and GitHub Pages rebuilds the same URL automatically; no VPS or extra deploy workflow is needed. The page uses a relative script URL so it works at the repository's `/Vph/` path.

The current page is deliberately in static preview mode. It does not call payment or VPN APIs, and clearly indicates that VPN access and payment are not connected. A GitHub Pages Mini App cannot validate Telegram users, receive Stars payments, or provision VPN accounts; those features require running the Node.js backend on a server.

If Telegram BotFather has already been configured with `https://xstayis-hue.github.io/Vph/` as the Mini App URL, no bot-side URL change is needed. Otherwise, set that URL once in BotFather; future `main` branch publications update what the Mini App displays at the same address.

## Deploy with Docker and Caddy

Create DNS A records for both hosts, copy `.env.example` to `.env`, fill in all values, then run:

```sh
docker compose up -d --build
```

Caddy obtains and renews HTTPS certificates. SQLite data and Caddy certificates are stored in Docker volumes.

## Connect Telegram and payment webhooks

1. In BotFather, set the Mini App domain to `BASE_HOST` and configure the bot menu/app URL as `BASE_URL`.
2. In BotFather, set the bot description to `VPN-подписка Vph: управление подключением и поддержка.` and the about text to `Открой приложение Vph, чтобы посмотреть тарифы и статус VPN-подписки.` Upload `assets/vph-bot-avatar.png` as the profile photo; `assets/vph-bot-avatar.svg` is the editable source.
3. Register the Telegram webhook at `BASE_URL/webhooks/telegram`. Pass the same `TELEGRAM_WEBHOOK_SECRET` as `secret_token` and subscribe to `message` and `pre_checkout_query` updates. `/start` now greets the user and shows an Open Vph button. Do setup from a private admin session; never put the bot token in a command checked into the repository.
4. In the Crypto Pay app settings, set the webhook URL to `CRYPTO_BASE_URL/webhooks/crypto`. Crypto Pay requests are authenticated using the signature header and are rechecked against the provider API before provisioning.
5. Open the bot Mini App and make a small Stars test purchase. Test crypto payments only on a Crypto Pay test app before enabling production.

In BotFather, `/setcommands` can be configured with:

```text
start - Открыть Vph
support - Поддержка
paysupport - Вопрос по оплате
```

## Backend behavior

- Telegram `initData` is signature-checked on the server and rejected when stale.
- Prices are chosen from the server-side plan configuration; client-submitted prices are ignored.
- Orders and subscription state are persisted in SQLite. Duplicate provider events do not grant the same order twice.
- Telegram pre-checkout and successful-payment updates are verified before Marzban is changed.
- The bot responds to `/start` with a welcome message and Mini App button; its avatar artwork is in `assets/vph-bot-avatar.svg`.
- The bot provides `/paysupport`; the Stars charge ID and Telegram user ID are stored with the order for support and refund processing.
- Crypto Pay webhooks are signature-checked, then the invoice is fetched from Crypto Pay and its asset, payload, amount, and paid status are compared with the order.
- Marzban users receive a stable account name; successful renewals extend the stored expiration date. Provisioning failures do not pretend the VPN is active and can be retried from the relevant checkout page.

The VPN subscription URL is a private access credential. Treat it like a password and do not share it.
