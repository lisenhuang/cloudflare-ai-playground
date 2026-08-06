# CF Models

A playground for **every** model in the Cloudflare AI catalog — Workers AI and third-party alike —
with live pricing and an input form generated from each model's own JSON Schema.

Built on Cloudflare Workers + Hono + React. Bring your own key.

## What it does

- **Browses the whole catalog** from `GET /ai/models/search`, with search, task-type and author
  facets, and Cloudflare-vs-third-party filtering. Every page of results is walked, and both catalog
  formats are unioned, so no task type goes missing. Filters survive opening a model and coming back.
- **Prices every model from the API.** No price is hardcoded anywhere in this repo — see
  [Pricing](#pricing) below.
- **Generates a form per model** from `GET /ai/models/schema`, so a model added to Cloudflare
  tomorrow is usable today with no code change. Anything the widget mapping can't express falls back
  to a JSON editor, so no model is ever un-runnable.
- **Renders output by task type** — streamed text, images, audio, video, transcripts, embeddings,
  classification scores — decided from the actual response rather than the task label.
- **Reports real cost per run** from the `usage` payload and `cf-aig-*` response headers, plus a
  session total. Estimates are never substituted for what Cloudflare actually charged.
- **Shows the current AI Gateway credit balance** in the header and refreshes it automatically.
- **Follows your system theme** automatically, with an optional manual override.
- **Works on phone and desktop**: two panes side by side on wide screens, tabbed panes on narrow.

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173
```

Open the app and supply:

| Field | Where to find it |
| --- | --- |
| **Account ID** | The 32-char hex string in your dashboard URL, after `dash.cloudflare.com/` |
| **API token** | [Create one](https://dash.cloudflare.com/profile/api-tokens) with **Workers AI → Edit**; add **AI Gateway → Read** to show the balance |
| **Gateway ID** *(optional)* | An [AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) name |

Deploy with `npm run deploy`.

### About the optional Gateway ID

Cloudflare's unified `/ai/run` endpoint requires a `cf-aig-gateway-id` header for Workers AI models
(it is optional for third-party ones). With a gateway configured, every model goes through one code
path and you get per-request cost reporting. Without one, the app automatically falls back to the
path-based `/ai/run/{model}` route for `@cf/...` models, which needs no gateway. Either way it works.

## Security: this is a bring-your-own-key app

Your token is kept in `localStorage` and sent only to this app's own `/api/*` proxy, which forwards
it to `api.cloudflare.com` **without storing, caching, or logging it**. There are no secrets in
`wrangler.jsonc` and no server-side account.

That design has a real consequence worth stating plainly: **anyone who can run JavaScript on this
origin can read the token.** So:

- Scope the token to **Workers AI → Edit** and, if you want the balance, **AI Gateway → Read**, on a single account.
- Give it an expiry.
- If you deploy this publicly, understand that every visitor pays for their own inference — but also
  that an XSS bug on the page would expose their token. Do not add third-party scripts to it.

Use the **Disconnect** button in the header to wipe the stored credentials.

## Pricing

Cloudflare's published pricing page documents only a subset of the catalog, so a table checked into
this repo would be both stale and incomplete. Pricing is instead resolved at runtime, in order
([`src/client/pricing/resolve.ts`](src/client/pricing/resolve.ts)):

1. **`GET /ai/catalog/models`** — the authenticated account catalog, including Unified Billing prices.
2. **`GET /ai/models/search?format=openrouter`** — the marketplace format, which normalizes token
   pricing across Cloudflare-hosted and third-party models.
3. **The default catalog response's own metadata** — where non-token units (per image, per step, per
   audio minute) and neuron rates live.
4. **Nothing.** A model with no published price displays "Price not published" — never a guess, never
   `$0`.

Token prices are normalized to USD per million tokens so the catalog can be sorted and compared;
image, audio and video models keep their native unit, because a per-token conversion would be
meaningless for them.

## Third-party models

Cloudflare's public model-search API (`/ai/models/search`) returns **only Workers AI models**. The
authenticated account catalog (`/ai/catalog/models`) is a separate, paginated source that includes
the third-party models available to the account and their per-model Unified Billing prices.

The app combines the account catalog with Cloudflare's own **published catalog**. The Worker fetches
`developers.cloudflare.com/ai/models` server-side (the browser cannot, for CORS reasons), parses the
structured `data-*` attributes on each model cell, and merges the result with live API data. Account
catalog records are preferred for third-party pricing; the published docs remain the broader list
source for models not present in the account catalog.

This is a live fetch on every cache miss, not a list checked into the repo. It is also **HTML
parsing**, so it is the most fragile part of this codebase: if Cloudflare changes that page's markup
it returns nothing, and the app falls back to showing Workers AI models only. That failure is
visible in the **Catalog coverage** panel rather than silent, and `Open a model by ID` always works
regardless.

To actually run one:

1. Put credits in your [AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway)
   (**Credits Available → Manage → Top-up**), or store a provider key on the gateway for BYOK.
   Without either, running returns `402 Insufficient balance`.
2. Note Cloudflare adds a **5% fee** on credits bought through Unified Billing; inference rates
   themselves pass through without markup.

Third-party models publish no input schema (`/ai/models/schema` returns 404), so the runner opens its
JSON editor seeded with a chat-shaped template. They reply in their provider's native format — the
output renderer handles Anthropic content blocks and OpenAI `choices` alongside Cloudflare's shape.

## Caching

The catalog is read live from Cloudflare and **never** hardcoded — but it is cached so the app
paints instantly. `src/client/state/catalogCache.ts` implements stale-while-revalidate:

- The cache is scoped per account ID, expires after 24 hours, and carries a version number so a
  loader fix invalidates entries produced by the old one.
- A warm cache renders immediately, then a background refresh replaces it. The header shows how old
  the data is, and **Refresh** forces a re-fetch.
- If a background refresh fails, the cached list stays on screen with an explicit warning rather
  than blanking out.
- Disconnecting clears the cached catalog along with the token.

Per-model input schemas are cached separately in `sessionStorage`, keyed by model ID.

## Pinning the API shapes

Parts of the catalog response are not fully specified in Cloudflare's public docs. The probe script
dumps the real payloads so the field mapping can be checked against reality:

```bash
CF_ACCOUNT_ID=xxx CF_API_TOKEN=yyy npm run probe
```

It writes raw responses to `.probe/` (gitignored) and prints where pricing, task type and capability
data actually live — plus whether the unified `/ai/run` endpoint accepts a Workers AI model without a
gateway ID on your account.

## Layout

```
src/
  worker/
    index.ts          Hono routes: /api/models, /api/schema, /api/run, /api/cf/* passthrough
    cf-proxy.ts       Credential extraction, streaming upstream fetch, error normalization
  shared/types.ts     Types shared across the client/worker boundary
  client/
    api/              Fetch layer, response normalization, catalog load + filter + sort
    pricing/          API-sourced price resolution and unit formatting
    form/             JSON Schema → widget mapping, and the generated form
    output/           Task-type-aware output renderers
    pages/            Setup, Catalog, ModelRunner
    state/            Credentials, theme, catalog hook, hash router
scripts/probe.mjs     API shape probe
```

## Notes and limits

- Text rendering handles fenced code blocks and preserves line breaks; it is not a full Markdown
  renderer, so nothing gets silently swallowed.
- Long-running models (video, music) are submitted as queued jobs and polled every 3s for up to 10
  minutes. A pending job is stored in `localStorage`, so a page refresh resumes polling.
- The whole catalog is loaded once and filtered in memory. That is what makes sorting by price
  correct — the API cannot rank on a field it does not sort by.
- Pagination does **not** assume the API honours the requested `per_page`. Cloudflare caps it at its
  own maximum, and treating a short page as the end of the list silently truncated the catalog to a
  single page — which is how the video and music models went missing. The loader now walks pages
  until the server reports completion.
- Project conventions, including the git rules for AI assistants, live in [CLAUDE.md](CLAUDE.md).
  Shared editor settings — including the commit-message generation prompts — are checked in under
  [.vscode/settings.json](.vscode/settings.json) on purpose.
