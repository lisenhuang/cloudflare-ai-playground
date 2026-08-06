# CF Models 🤖

Cloudflare AI playground for **Workers AI and third-party models**.

🌐 Live app: <https://cf-models.ase.workers.dev>

Built with **Cloudflare Workers + Hono + React**.

## ✨ What you get

| Feature | Description |
| --- | --- |
| 🔎 Catalog | Search, filter, sort, and open models by ID |
| 💰 Pricing | Live API pricing with no hardcoded guesses |
| 🔐 OAuth | One-click Cloudflare sign-in with PKCE |
| 🧾 Token fallback | Manual API-token setup is available when needed |
| ▶️ Runner | Forms generated from each model's JSON Schema |
| 📊 Usage | Real request cost, latency, and session totals |
| 💳 Balance | AI Gateway credits shown in the header |
| 📱 Responsive | Works on desktop and mobile |

## 🚀 Run locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## 🔐 Connect Cloudflare

Click **Continue with Cloudflare**. The app opens Cloudflare's consent screen, discovers your
accounts, and stores the resulting session in this browser.

### OAuth permissions

| Permission | Used for |
| --- | --- |
| Account Settings → Read | Discover available accounts |
| Workers AI → Read/Edit | Browse and run Workers AI models |
| AI Gateway → Read | Read the credit balance |
| AI Gateway → Run | Run models through a gateway |

> ℹ️ The current OAuth client is private, so it is available to members of the creating Cloudflare
> account. Public access requires Cloudflare domain verification.

### Manual token fallback

Expand **Use an API token instead** and provide:

| Field | Value |
| --- | --- |
| Account ID | 32-character ID from the Cloudflare dashboard URL |
| API token | Workers AI → Edit; add AI Gateway → Read for balance |
| Gateway ID | Optional AI Gateway name |

Tokens stay in this browser and pass only through this app's `/api/*` proxy. Scope manual tokens
narrowly and give them an expiry. Disconnecting removes stored credentials.

## 🧭 How a request works

```text
+-------------+    /api/*     +-------------+    Bearer token    +-------------+
| Browser UI  | ------------> | CF Models   | ----------------> | Cloudflare  |
| React       | <------------ | Worker/Hono | <---------------- | AI API      |
+-------------+   streamed    +-------------+     response       +-------------+
```

The Worker does not store account IDs, tokens, prompts, or model output.

## 💰 Pricing

Pricing is resolved at runtime in this order:

| Priority | Source | Best for |
| ---: | --- | --- |
| 1 | `GET /ai/catalog/models` | Account-specific Unified Billing prices |
| 2 | `GET /ai/models/search?format=openrouter` | Marketplace token prices |
| 3 | Catalog metadata and Cloudflare docs | Images, audio, video, neurons, and fallback models |
| — | Nothing | Shows **Price not published** instead of guessing `$0` |

Third-party models are account-aware:

```text
Cloudflare account catalog --+
Cloudflare published docs ---+--> merged model list --> filters + runner
Marketplace pricing --------+
```

Third-party models generally require either:

- 💳 AI Gateway credits, or
- 🔑 a provider key configured for BYOK.

If a third-party model has no schema, the runner opens a JSON editor with a chat-shaped starter
input.

## 💳 AI Gateway balance

The header balance is read from:

```text
GET /accounts/{account_id}/ai-gateway/billing/credit-balance
```

It refreshes when clicked and automatically every 60 seconds. Missing AI Gateway Read permission
is shown as **Credits unavailable** with a short hint.

## 🗃️ Caching

| Data | Storage | Behavior |
| --- | --- | --- |
| Catalog | `localStorage` | Account-scoped, 24-hour cache, stale-while-revalidate |
| Model schemas | `sessionStorage` | Cached per model for the current session |
| Pending video/music jobs | `localStorage` | Polling can resume after refresh |

Use **Refresh** for a fresh catalog. **Disconnect** clears the account's catalog cache.

## 🧪 Probe Cloudflare API shapes

Use the probe script when checking new or undocumented response fields:

```bash
CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy npm run probe
```

Raw responses are written to `.probe/` (gitignored).

## 🗂️ Project map

```text
src/
├── worker/
│   ├── index.ts       API routes and SPA fallback
│   ├── cf-proxy.ts    Credential handling and Cloudflare proxy
│   └── docs-catalog.ts Published model catalog fallback
├── client/
│   ├── auth/          OAuth + PKCE
│   ├── api/           Fetching, catalog loading, normalization
│   ├── pricing/       Price resolution and formatting
│   ├── form/          JSON Schema → form widgets
│   ├── output/        Text, JSON, image, audio, and video output
│   └── pages/         Setup, catalog, and model runner
└── shared/types.ts    Shared client/Worker types
```

## ⚠️ Limits

| Area | Note |
| --- | --- |
| Long jobs | Video and music jobs are queued and polled for up to 10 minutes |
| Markdown | Text output preserves fenced code and line breaks; it is not a full Markdown renderer |
| Catalog | Cloudflare API and docs markup can change; coverage is shown in the UI |
| Billing | Third-party inference needs Unified Billing credits or provider BYOK |
