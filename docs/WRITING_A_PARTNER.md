# Writing a partner

This guide explains how to integrate a **partner** service with Ark's document backend. Ark stores and serves the sheets itself; your partner authenticates users, receives live change notifications, and reads or writes sheets through Ark's CRUD API.

## What you build

You implement **three** small endpoints on your base URL (**`ARK_PARTNER_BASE_URL`**, no trailing slash):

1. **`GET /ark/auth`** — Ark calls this to verify a user's `ark_token` (sent as `Authorization: Bearer …`). Return **2xx** to allow.
2. **`GET /ark/template/{path}`** — Ark pulls this **live at document-creation time** to learn how a new sheet should look (columns, options, optional prefill rows). Your response **must include a `version`**; the document records the template name + version. Return **404** for paths that should start blank. No registration step, no startup-order dependency.
3. **`POST /ark/notify`** — Ark POSTs live, coalesced **`sheet.changed`** notifications as users edit. When you need full state, pull the sheet back from Ark.

And you **call** Ark's partner CRUD API (Bearer **`ARK_PARTNER_API_TOKEN`**):

- **`GET /api/partner/sheets/{path}`** — read a full sheet document (includes its `template` name/version).
- **`PUT /api/partner/sheets/{path}`** — create/replace a sheet (open tabs update live).
- **`PATCH /api/partner/sheets/{path}`** — update individual cells or metadata (pushed to open tabs live).

If your users open Ark inside an **iframe** on a **different** domain than Ark (for example **`https://example.com`** embedding **`https://ark.example.com`**), configure **`ARK_IFRAME_FRAME_ANCESTORS`** (and optionally **`ARK_IFRAME_X_FRAME_OPTIONS`**) on the Ark server—see **[PARTNER_API.md — Framing](PARTNER_API.md#framing-iframe-embedding)**.

## Minimal first slice

You can start with **no partner at all**: run Ark, open **`/clients`**, and a blank sheet is auto-created and persisted in Ark's own database. Then grow into a partner integration:

1. Stand up any web stack you like (FastAPI, Express, etc.) and add **`GET /ark/auth`** (return 200) and **`POST /ark/notify`** (log the body).
2. Add **`GET /ark/template/{path}`** returning your columns and a version:

```json
{
  "name": "client",
  "version": 1,
  "title": "Client",
  "columns": [{ "id": "name", "header": "Name", "widthPx": 240 }],
  "rows": [{ "name": "Seeded row" }]
}
```

3. Run Ark with **`ARK_PARTNER_BASE_URL`** pointing at your server (e.g. `http://127.0.0.1:9000`) and a shared **`ARK_PARTNER_API_TOKEN`**.
4. List that path in **`ARK_UI_ROUTES`** (comma-separated exact segments and/or **`prefix/*`** wildcards, e.g. `clients,records,clients/*`) so Ark serves the SPA at those URLs.
5. Open **`http://127.0.0.1:8000/clients/21`** (adjust host/port). Ark asks your template endpoint how the new sheet should look, saves the document with your template's name/version, and edits appear at your `/ark/notify` endpoint.

Try the in-repo sample: [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py) with `uvicorn example_api:app --port 9000`, or the Dockerized demo in [`examples/partner-sqlite-demo`](https://github.com/valteryde/ark/tree/main/examples/partner-sqlite-demo).

## Sheet payloads

The UI turns the sheet document into a grid configuration aligned with TypeScript types in [`src/spreadsheet/types.ts`](https://github.com/valteryde/ark/blob/main/src/spreadsheet/types.ts).

**Minimum concept:** an array of **columns** (id, header, width, optional read-only / value types) and an array of **rows** (plain objects whose keys match column **`id`** values). The same shape is used for `PUT /api/partner/sheets/{path}` bodies and for what `GET` returns.

For **dropdown columns** with colored chips and icons, use **`valueType: "select"`** and put **`color`**, **`backgroundColor`**, and **`icon`** on each **`selectOptions`** entry (see **[PARTNER_API.md](PARTNER_API.md)**).

**Full field list and UI flags** — see **[PARTNER_API.md](PARTNER_API.md)** (payload reference).

## Syncing: `POST /ark/notify`

When someone edits a cell, Ark persists it immediately (the sheet document is the source of truth), broadcasts to other tabs, and enqueues a notification to you. Events are coalesced per sheet and user for ~250 ms:

```json
{
  "type": "sheet.changed",
  "sheetPath": "clients",
  "revision": 42,
  "events": [
    { "kind": "cell", "row": 1, "col": 2, "columnId": "name", "value": "Acme Corp", "recordId": 1 }
  ]
}
```

**Practical notes:**

- Treat notifications as **triggers, not payloads**: on `sheet.changed`, `GET /api/partner/sheets/{sheetPath}` and diff/sync into your own storage. The notification body is enough for simple auditing, but the pull gives you consistent full state at a known `revision`.
- Delivery is **fire-and-forget with one retry**; design your sync to be idempotent and pull-based so a missed notification only delays convergence until the next edit.
- **`row`** is a **1-based grid index** in Ark's document, not your SQL primary key. Mark your key column **`readOnly: true`** and store record ids in it so `kind: "cell"` events carry **`recordId`** and you can sync by id.
- When a user types a **new row** in the grid, it has no `recordId` yet. Insert it into your database, then **`PATCH`** the generated id back into the sheet's read-only id column (the sample partner does exactly this).
- The notification carries the editing user's **`ark_token`** as a Bearer header for auditing.

## Pushing data into sheets

Your backend changed data and open tabs should see it?

- **`PATCH /api/partner/sheets/{path}`** with `cells` for in-place updates — open tabs apply them live, no remount.
- **`PUT /api/partner/sheets/{path}`** to replace the whole document (bulk import, reorder, schema change) — open tabs remount with fresh state.

## URLs and routing

- The **browser path** (no leading slash; all segments after trimming slashes) is the sheet path: **`/clients`** → sheet **`clients`**; **`/user_transactions/xyz`** → sheet **`user_transactions/xyz`**.
- **`ARK_UI_ROUTES`** lists each exact **single segment** you want as an SPA root, and/or **`prefix/*`** entries so every URL under **`/prefix/…`** serves the SPA (each path segment uses letters, digits, hyphen only).
- Any allowed URL resolves to a sheet: existing documents load, unknown paths **auto-create** (from your `GET /ark/template/{path}` response, else blank on 404).

Details: **[PARTNER_API.md](PARTNER_API.md)** (browser URLs and templates sections).

## Authentication and credentials

### Partner token (recommended for user-scoped access)

When your app **redirects** the user into Ark, add **`ark_token`** to the URL (query or hash). The SPA stores it in **`sessionStorage`**, sends **`Authorization: Bearer <token>`** on sheet requests, and passes the same token on the **WebSocket** query string.

- **Query:** `https://ark.example.com/clients?ark_token=…` — simple; the token may appear in server access logs for the initial HTML request.
- **Hash:** `https://ark.example.com/clients#ark_token=…` — the token is not sent to Ark on the first navigation; the SPA reads it from the hash, persists it, and strips it from the address bar.

Ark verifies the token against your **`GET /ark/auth`** endpoint and caches the result (**`ARK_AUTH_CACHE_TTL`**, default 300 s). Your endpoint decides everything — including whether **anonymous** users (no token) are allowed. If **`ARK_PARTNER_BASE_URL`** is unset, all requests are accepted (local dev).

Full contract: **[PARTNER_API.md](PARTNER_API.md)** (partner token section).

## Examples in this repository

| Example | What it shows |
| ------- | ------------- |
| [`example_api.py`](https://github.com/valteryde/ark/blob/main/example_api.py) | Minimal partner: `/ark/auth`, `/ark/template/{path}`, `/ark/notify`. |
| [`examples/partner-sqlite-demo`](https://github.com/valteryde/ark/tree/main/examples/partner-sqlite-demo) | Compose stack: Ark document backend + SQLite partner that syncs on notify and patches ids back. |

## Where to read next

- **[PARTNER_API.md](PARTNER_API.md)** — Canonical contract (auth, notifications, CRUD API, payloads).
- **[SPREADSHEET.md](SPREADSHEET.md)** — What the grid supports (column types, undo, toolbar flags).
- **[GETTING_STARTED.md](GETTING_STARTED.md)** — Run Ark locally, Docker, and registry images.

Partner-facing frontend wiring (for contributors) lives under [`src/partner/`](https://github.com/valteryde/ark/tree/main/src/partner) and [`src/main.ts`](https://github.com/valteryde/ark/blob/main/src/main.ts).
