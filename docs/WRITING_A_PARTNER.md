# Writing a partner

This guide explains how to implement the **partner** service Ark talks to: the HTTP API at the base URL you set in **`ARK_BACKEND_URL`** (no trailing slash).

## What you build

You implement **two** core pieces on your base URL:

1. **`GET /ark/routing/{path}`** — Return JSON that describes one spreadsheet (columns, rows, options).
2. **`POST /ark/tunnel`** — Accept persisted “tunnel” events when users commit cell values (and related collab traffic).

Optionally, when your data **order or row list** changes in a way that no longer matches what browsers have in memory, call the Ark BFF’s **`POST /api/ark/broadcast`** with a **`sheet.truth`** payload so open tabs resync (see **[PARTNER_API.md](PARTNER_API.md)** — broadcast section).

The Ark **BFF** ([`server/app/main.py` on GitHub](https://github.com/valteryde/ark/blob/main/server/app/main.py)) proxies the browser’s same-origin **`GET /api/ark/routing/{path}`** to your **`GET /ark/routing/{path}`**, and forwards **`Authorization`**, **`Cookie`**, and standard accept headers. The browser never calls your partner origin directly, so you avoid CORS for those reads.

## Minimal first slice

1. Stand up any web stack you like (FastAPI, Express, etc.).
2. Add **`GET /ark/routing/clients`** (or another segment) that returns JSON with at least **`columns`** and **`rows`** (see below).
3. Run Ark with **`ARK_BACKEND_URL`** pointing at your server (e.g. `http://127.0.0.1:9000`).
4. List that URL segment in **`ARK_UI_ROUTES`** (comma-separated, e.g. `clients,records`) so Ark serves the SPA at **`/clients`**.
5. Open **`http://127.0.0.1:8000/clients`** (adjust host/port). You should see a grid backed by your JSON.

Try the in-repo sample: [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py) with `uvicorn example_api:app --port 9000`, or the Dockerized demo in [`examples/partner-sqlite-demo`](https://github.com/valteryde/ark/tree/main/examples/partner-sqlite-demo).

## Sheet payload (routing response)

The UI turns your JSON into a grid configuration aligned with TypeScript types in [`src/spreadsheet/types.ts`](https://github.com/valteryde/ark/blob/main/src/spreadsheet/types.ts).

**Minimum concept:** an array of **columns** (id, header, width, optional read-only / value types) and an array of **rows** (plain objects whose keys match column **`id`** values). You can also use a **nested** shape with **`sheets`**; Ark normalizes using the first sheet.

For **dropdown columns** with colored chips and icons, use **`valueType: "select"`** and put **`color`**, **`backgroundColor`**, and **`icon`** on each **`selectOptions`** entry (see **[PARTNER_API.md](PARTNER_API.md)**).

**Full field list, nested shapes, and UI flags** — see **[PARTNER_API.md](PARTNER_API.md)** (routing section).

## Persistence: `POST /ark/tunnel`

When someone edits a cell, the client sends JSON over **`WebSocket /ws/ark`**. The BFF broadcasts to other tabs and maps the event to a JSON body **`POST`ed** to **`{ARK_BACKEND_URL}/ark/tunnel`**.

Typical mapped shape for a value commit:

```json
{
  "type": "update_cell",
  "row": 0,
  "col": 1,
  "columnId": "name",
  "value": "Acme Corp",
  "meta": {}
}
```

Other **`type`** values and the exact mapping from WebSocket messages are documented in **[PARTNER_API.md](PARTNER_API.md)** (tunnel section).

**Practical notes:**

- Treat tunnel posts as **best-effort notifications** unless you define stronger guarantees; the sample partner overwrites storage from each event.
- Order is generally **sequential per deploy**; design idempotency if you retry or scale out.
- **`row`** is a **grid index** (aligned with your **`rows`** array order from routing / last truth push), not necessarily your SQL primary key. Mark your key column **`readOnly: true`** so Ark sends **`recordId`** on commits and you can **`UPDATE … WHERE id = ?`** without depending on index alone.
- If you insert a row and your default **`ORDER BY`** moves it to another visual position, open tabs may disagree on indices until you **`POST /api/ark/broadcast`** a fresh **`sheet.truth`** (or the user reloads).

## URLs and routing

- The **first path segment** of the page URL selects the default sheet route: **`/clients`** → **`path`** = `clients` → **`GET /ark/routing/clients`**.
- **`ARK_UI_ROUTES`** must include every segment you want as a dedicated SPA entry (letters, digits, hyphen only per segment).
- You can use a **longer** `{path}` (e.g. `v1/clients`) if your first segment is still listed in **`ARK_UI_ROUTES`** and your links use that path. The full suffix after `/api/ark/routing/` is what gets proxied.

Details: **[PARTNER_API.md](PARTNER_API.md)** (browser URLs section).

## Authentication and credentials

### Partner token (recommended for user-scoped access)

When your app **redirects** the user into Ark, add **`ark_token`** to the URL (query or hash). The SPA stores it in **`sessionStorage`**, sends **`Authorization: Bearer <token>`** on **`GET /api/ark/routing/{path}`**, and passes the same token on the **WebSocket** query string so the BFF can attach **`Authorization`** to **`POST /ark/tunnel`**.

- **Query:** `https://ark.example.com/clients?ark_token=…` — simple; the token may appear in server access logs for the initial HTML request.
- **Hash:** `https://ark.example.com/clients#ark_token=…` — the token is not sent to Ark on the first navigation; the SPA reads it from the hash, persists it, and strips it from the address bar.

Ark does **not** validate the token; your **`GET /ark/routing/*`** and **`POST /ark/tunnel`** handlers should require a valid **`Authorization`** header and return **`401`** when it is missing or invalid.

Full contract: **[PARTNER_API.md](PARTNER_API.md)** (partner token section).

### Cookies and other headers

For **`GET /ark/routing/{path}`**, the BFF also forwards **`Cookie`** and standard accept headers from the browser. You can combine cookies with a partner token if your deployment sets same-origin cookies on the Ark host.

## Examples in this repository

| Example | What it shows |
| ------- | ------------- |
| [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py) | Small FastAPI partner for **`clients`** / **`records`**. |
| [`examples/partner-sqlite-demo`](https://github.com/valteryde/ark/tree/main/examples/partner-sqlite-demo) | Compose stack: Ark + SQLite-backed partner. |

## Where to read next

- **[PARTNER_API.md](PARTNER_API.md)** — Canonical contract (routing, tunnel, WebSocket).
- **[SPREADSHEET.md](SPREADSHEET.md)** — What the grid supports (column types, undo, toolbar flags).
- **[GETTING_STARTED.md](GETTING_STARTED.md)** — Run Ark locally, Docker, and registry images.

Partner-facing frontend wiring (for contributors) lives under [`src/partner/`](https://github.com/valteryde/ark/tree/main/src/partner) and [`src/main.ts`](https://github.com/valteryde/ark/blob/main/src/main.ts).
