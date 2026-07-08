# Partner API contract

New to partners? Read **[Writing a partner](WRITING_A_PARTNER.md)** first.

**Ark owns the sheet documents.** The Ark server (`server/app/main.py`) stores sheets in its own SQLite database, serves them to browsers, and persists every edit itself. Your partner app integrates in four ways:

1. **Auth** — Ark verifies user tokens against your **`GET /ark/auth`** endpoint (when **`ARK_PARTNER_BASE_URL`** is set).
2. **Templates** — When Ark creates a new document it pulls the template live from your **`GET /ark/template/{path}`** endpoint. The response **must include a `version`**; the document records the template name + version it was built from.
3. **Notifications** — Ark POSTs live, lightweight **`sheet.changed`** notifications to your **`POST /ark/notify`** endpoint as users edit.
4. **CRUD API** — You read and write full sheet documents through **`/api/partner/…`** on the Ark server.

Sheets are **auto-created** on first visit: when a user opens **`/clients/21`** and no document exists, Ark fetches your template for that path (or creates a blank generic spreadsheet if you return 404) and saves the document immediately. There is **no template registration step** and no startup-order dependency between Ark and your service.

Ark is **one spreadsheet per browser URL**. Opening **`/clients`** loads that sheet only; **`/records`** is a separate page with its own grid. Link between them with normal HTML links if you want.

## Environment variables (Ark server)

| Variable | Purpose |
| -------- | ------- |
| `ARK_DB_PATH` | SQLite file for Ark's sheet documents (default `./ark.db`). |
| `ARK_PARTNER_BASE_URL` | Your partner base URL (no trailing slash). Enables token verification (`GET {base}/ark/auth`), template pulls (`GET {base}/ark/template/{path}`), and change notifications (`POST {base}/ark/notify`). Unset = no auth, blank auto-create, no notifications (local dev). |
| `ARK_PARTNER_API_TOKEN` | Bearer token your backend uses on `/api/partner/…` routes. Unset = partner CRUD API disabled (503). |
| `ARK_AUTH_CACHE_TTL` | Seconds to cache token verification results (default 300). |
| `ARK_NOTIFY_COALESCE_MS` | Coalescing window for change notifications (default 250). |
| `ARK_UI_ROUTES` | Comma-separated SPA route specs (see Browser URLs). |

## Partner token (`ark_token`)

Partners can redirect users to Ark with a **token** the partner will recognize:

1. Add **`ark_token`** to the landing URL (**query** `?ark_token=…` or **hash** `#ark_token=…`).
2. The browser app saves it in **`sessionStorage`**, removes it from the visible URL, and sends **`Authorization: Bearer <token>`** on each sheet request. The collab **WebSocket** is opened as **`/ws/ark?ark_token=…`**.
3. When **`ARK_PARTNER_BASE_URL`** is set, Ark verifies each unseen token with **`GET {base}/ark/auth`** carrying **`Authorization: Bearer <token>`** (no header for anonymous requests). A **2xx** response means valid; anything else rejects the request (HTTP **401**, WebSocket close **4401**). Results are cached for **`ARK_AUTH_CACHE_TTL`** seconds.
4. The same token is forwarded as **`Authorization: Bearer <token>`** on the **`sheet.changed`** notifications produced by that user's edits, so you can audit who changed what.

Use **HTTPS** and **short-lived** tokens in production. Prefer **hash** over **query** if you want to avoid the token in the initial document request and some referrer chains. Ark never interprets the token — your `/ark/auth` decides.

## Routes you implement (on `ARK_PARTNER_BASE_URL`)

### `GET /ark/auth`

Receives **`Authorization: Bearer <ark_token>`** (absent for anonymous users). Return **2xx** to allow, anything else to deny. This is the only auth gate — decide here whether anonymous access is allowed.

### `GET /ark/template/{path}`

Called **once per document, at creation time**, when a user opens a sheet path that has no document yet. Receives the requesting user's **`Authorization: Bearer <ark_token>`**. Respond with:

```json
{
  "name": "client",
  "version": 3,
  "title": "Client",
  "columns": [ { "id": "name", "header": "Name", "widthPx": 240 } ],
  "rows": [ { "name": "Prefilled row" } ],
  "rowCount": 100
}
```

- **`version`** (required, string or integer) — Ark **rejects** template responses without one. The created document stores `name` + `version`, and both appear as **`template`** in every sheet payload and in the `sheet_created` notification — so when you change a template later, you can tell which documents were created from which version.
- **`columns`** (required) and any other sheet payload fields (`title`, `rowCount`, `enabledUiCapabilities`, `chromeActions`, …).
- **`rows`** (optional) — prefill for the new document (useful for seeding data without any startup push).
- **`name`** (optional) — template identifier stored on the document.

Status handling:

| Your response | Ark behavior |
| ------------- | ------------ |
| 2xx with valid template | Document created from the template. |
| **404** | No template for this path — a blank generic sheet is created. |
| Any other error / unreachable / missing `version` | Request fails (**502**), **no document is created** — a temporary partner outage never pins a wrongly-blank document; the next visit retries. |

Templates are only consulted at creation. Existing documents never change when your template changes; use the CRUD API if you want to migrate them.

### `POST /ark/notify`

Ark sends live change notifications as users edit. Events for the same sheet and user are **coalesced** for a short window (default 250 ms), so a paste of 200 cells arrives as one batch while single edits are effectively instant.

```json
{
  "type": "sheet.changed",
  "sheetPath": "clients/21",
  "revision": 42,
  "events": [
    { "kind": "cell", "row": 3, "col": 2, "columnId": "name", "value": "Acme", "recordId": 21 },
    { "kind": "row_deleted", "row": 5, "recordId": 7 },
    { "kind": "sheet_created", "path": "clients/21", "template": { "name": "client", "version": "3" } }
  ]
}
```

- **`revision`** — the sheet's document revision after the last event in the batch. Increments on every mutation.
- **`kind: "cell"`** — a committed cell value. `row`/`col` are 1-based grid indices; `columnId` matches the sheet's column config; `recordId` is the row's first read-only column value when present.
- **`kind: "row_deleted"`** — user deleted a grid row (cells cleared; rows are not shifted).
- **`kind: "sheet_created"`** — a sheet was auto-created on first visit; includes the `template` name/version it was built from (absent for blank sheets).

The notification is intentionally lightweight: when you need full state, pull the sheet with **`GET /api/partner/sheets/{path}`**. Notifications carry the editing user's `ark_token` as a Bearer header and are fire-and-forget (one retry); Ark never blocks the grid on your response.

## Ark's partner CRUD API (`/api/partner/…`)

All routes require **`Authorization: Bearer <ARK_PARTNER_API_TOKEN>`**.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/partner/sheets` | List sheets (`path`, `title`, `revision`, `updatedAt`). |
| `GET` | `/api/partner/sheets/{path}` | Full sheet document (same shape browsers get, plus `revision`). |
| `PUT` | `/api/partner/sheets/{path}` | Create or fully replace a sheet. Open tabs remount live (`sheet.truth` push). |
| `PATCH` | `/api/partner/sheets/{path}` | Partial update: cells and/or metadata. Open tabs apply cell updates live without remounting. |
| `DELETE` | `/api/partner/sheets/{path}` | Delete the document. |

### `PUT /api/partner/sheets/{path}` (create / replace)

Body is a sheet payload: **`columns`** (required), plus optional `rows`, `title`, `description`, `rowCount`, `ghostRowCount`, `defaultRowHeightPx`, `enabledUiCapabilities`, `chromeActions`. Field semantics are in the payload reference below. Rows are objects keyed by column `id`.

### `PATCH /api/partner/sheets/{path}` (partial update)

```json
{
  "title": "Optional new title",
  "rowCount": 200,
  "cells": [
    { "row": 1, "columnId": "name", "value": "Acme Corp" },
    { "recordId": 2, "columnId": "name", "value": "Beta LLC" },
    { "row": 3, "col": 2, "value": "Gamma" }
  ]
}
```

Each cell update addresses a cell by **`row` + `columnId`**, **`recordId` + `columnId`** (row resolved through the first read-only column), or raw **`row` + `col`**. An empty-string `value` clears the cell. Applied updates are broadcast to open tabs as live cell commits.

## Sheet payload reference

`GET /api/sheets/{path}` (browser) and `GET /api/partner/sheets/{path}` (partner) return:

| Field | Description |
|--------|-------------|
| `path` | Normalized sheet path. |
| `revision` | Document revision; increments on every mutation. |
| `template` | `{ "name"?, "version" }` of the partner template the document was created from (absent for blank sheets). Version is stored as a string. |
| `title` | Shown in the header when present; also used for `document.title` |
| `description` | Informational |
| `columns` | Array of column objects (see below) |
| `rows` | Array of row objects; keys match column `id` |
| `rowCount` | Visible grid height. Grows automatically when users write below it. |
| `cells` | Sparse out-of-schema cells keyed `"row:col"` (values written outside the defined columns), when present. |
| `defaultRowHeightPx` | Passed through to config |
| `enabledUiCapabilities` | Toolbar flags (see SPREADSHEET.md) |
| `chromeActions` | Up to **8** header links (top right). Each item is an object (see below). Invalid or unsafe URLs are skipped. |

**`chromeActions` entry** (each element of the array):

| Field | Required | Description |
| ----- | -------- | ----------- |
| `label` | yes | Button text. |
| `href` | yes | **Same-origin** path starting with **`/`** (e.g. **`/records`**), or an **`http:`** / **`https:`** / **`mailto:`** URL. Scheme-relative URLs (`//…`), `javascript:`, `data:`, etc. are rejected. |
| `variant` | no | **`ghost`** (outline; default) or **`primary`** (filled dark style). |
| `icon` | no | [Phosphor](https://phosphoricons.com/) **regular** name: lowercase letters, digits, hyphens only (e.g. **`arrow-square-out`**). |
| `openInNewTab` | no | If **`true`**, sets `target="_blank"` and `rel="noopener noreferrer"`. |

**Column object** (aligned with [`SpreadsheetColumn`](https://github.com/valteryde/ark/blob/main/src/spreadsheet/types.ts)):

| Field | Required | Description |
| ----- | -------- | ----------- |
| `id` | yes | Stable key for the column and for row objects (e.g. API field name). |
| `header` | yes | Column label in the grid header. |
| `widthPx` | yes | Width in CSS pixels. |
| `readOnly` | no | If `true`, the cell cannot be edited (computed / system fields). The **first** read-only column doubles as the record id: its value is sent as `recordId` on notifications. |
| `hidden` | no | If `true`, the column is read-only and **omitted from the grid** (no header or cells). Row data and `recordId` resolution still use the column; clipboard copy excludes hidden values. Setting `hidden: true` forces `readOnly: true`. |
| `valueType` | no | **`text`** (default), **`number`**, or **`select`**. Affects validation and editors. |
| `selectOptions` | no | When `valueType` is **`select`**, list of option objects (see below). |
| `allowEmpty` | no | On **`select`** columns: if `false`, committing empty uses the first option’s value. Default **`true`**. |

#### Select options and chips

For **`valueType: "select"`**, each entry in **`selectOptions`** is an object:

| Field | Required | Description |
| ----- | -------- | ----------- |
| `value` | yes | Stored cell value; commits must match exactly. |
| `label` | no | Shown in the grid and picker when set; otherwise `value` is shown. |
| `color` | no | Text color for the option chip (hex `#rgb` / `#rrggbb` / `#rrggbbaa`, or `rgb()` / `rgba()` with numeric components only). Invalid strings are ignored. |
| `backgroundColor` | no | Chip background; same validation as `color`. |
| `icon` | no | [Phosphor](https://phosphoricons.com/) **regular** icon name, lowercase with hyphens (e.g. `check-circle` → CSS classes `ph ph-check-circle`). Invalid names are ignored. |

If an option has **at least one** of `color`, `backgroundColor`, or a valid `icon`, the cell (and suggestion list) renders a **chip** with those styles. Options with **none** of these render as **plain escaped text** (label or value).

**Text and number columns** are always plain text (no per-column display style enum).

**Example — sheet with select chips (PUT body)**

```json
{
  "title": "Tasks",
  "columns": [
    { "id": "title", "header": "Task", "widthPx": 240 },
    {
      "id": "priority",
      "header": "Priority",
      "widthPx": 100,
      "valueType": "select",
      "selectOptions": [
        { "value": "HIGH", "backgroundColor": "#d8f3dc", "color": "#1b4332", "icon": "arrow-up" },
        { "value": "MEDIUM", "backgroundColor": "#fde8d4", "color": "#9a3412", "icon": "equals" }
      ]
    },
    { "id": "owner", "header": "Owner", "widthPx": 160 },
    { "id": "updatedAt", "header": "Updated", "widthPx": 140, "readOnly": true }
  ],
  "rows": [
    { "title": "Ship v1", "priority": "HIGH", "owner": "Alex", "updatedAt": "2026-04-01" }
  ]
}
```

## Browser-facing API (for reference)

- **`GET /api/sheets/{path}`** — sheet payload, auto-creating unknown paths. Requires a valid `ark_token` when `ARK_PARTNER_BASE_URL` is set.
- **WebSocket `/ws/ark`** — collab channel. Browsers send:
  - `{ "type": "cell.value_committed", "row", "col", "columnId", "value", "sheetPath", "clientId"?, "markerHue"?, "recordId"? }` — Ark persists the cell, bumps the revision, broadcasts to peers, and enqueues a partner notification. On a persistence failure only the sender receives `{ "type": "cell.persist_status", "ok": false, "row", "col", … }`.
  - `{ "type": "row.deleted", "row", "sheetPath", … }` — Ark clears the row's cells, broadcasts, and notifies.
  - `{ "type": "cell.presence" | "cell.presence_clear", … }` — ephemeral cursor presence; broadcast only, never persisted or notified.
  - Browsers must not send `{ "type": "sheet.truth" }`; that shape is reserved for partner `PUT` pushes.

### Row index vs. database identity

**`row`** in notification events is the **1-based grid row** in Ark's document. Because Ark is now the system of record, indices are stable across clients — but they are still grid positions, not your database keys. Mark your key column **`readOnly: true`** and put record ids in it so notifications carry **`recordId`** and you can sync by id.

## Browser URLs (SPA)

The Ark server serves `index.html` for paths allowed by **`ARK_UI_ROUTES`**: a comma-separated list where each entry is either a **single segment** (letters, digits, hyphen) or a **prefix wildcard** **`base/*`**.

- **Exact:** `clients` serves the SPA at **`/clients`** and the UI calls **`GET /api/sheets/clients`**.
- **Wildcard:** `user_transactions/*` serves the SPA at **`/user_transactions`**, **`/user_transactions/abc`**, and any deeper path under that prefix. The **browser path without a leading slash** is the sheet path: e.g. **`/user_transactions/abc`** → **`GET /api/sheets/user_transactions/abc`**.

Multi-segment bases are allowed (e.g. **`api/v1/*`**). More specific prefixes should be listed before shorter ones in **`ARK_UI_ROUTES`** so overlapping rules resolve predictably (longer bases are registered first).

## Framing (iframe embedding)

You can load Ark inside a parent page’s **`<iframe>`** when the iframe **`src`** points at your Ark deployment (for example **`https://ark.example.com/clients`**).

Parent and Ark hosts are usually **different origins** (for example **`https://example.com`** vs **`https://ark.example.com`**). The Ark server ([`server/app/main.py`](https://github.com/valteryde/ark/blob/main/server/app/main.py)) can send framing-related HTTP headers controlled by environment variables:

| Variable | Purpose |
| -------- | ------- |
| **`ARK_IFRAME_FRAME_ANCESTORS`** | If set, Ark adds **`Content-Security-Policy: frame-ancestors <value>`**. Put only the directive sources (what follows **`frame-ancestors `**), space-separated—for example **`https://example.com`** so only that origin may embed Ark. Include **`https://www.example.com`** too if the parent app is served from both bare and **`www`** hosts. **`'self'`** refers to Ark’s origin (e.g. **`https://ark.example.com`**), not the parent frame. |
| **`ARK_IFRAME_X_FRAME_OPTIONS`** | If set, Ark adds **`X-Frame-Options`** with this exact value (typically **`DENY`** or **`SAMEORIGIN`**). For embedding from **`example.com`**, leave this **unset**: **`SAMEORIGIN`** allows framing only from **`https://ark.example.com`** itself and blocks the parent site. |

If both variables are unset, Ark does **not** add these headers (same behavior as older deployments).

Example **`.env`** on **`ark.example.com`** when the shell UI lives at **`https://example.com`**:

```bash
ARK_IFRAME_FRAME_ANCESTORS=https://example.com
```

Full notes and examples live in [`.env.example`](https://github.com/valteryde/ark/blob/main/.env.example).

## Local development

1. Run Ark with no partner at all: `uvicorn app.main:app --app-dir server` (serving `dist/`). Open **`http://127.0.0.1:8000/clients`** — the sheet is auto-created blank and edits persist in `ark.db`.
2. To integrate a partner, run it (e.g. `uvicorn example_api:app --port 9000`) and set `ARK_PARTNER_BASE_URL=http://127.0.0.1:9000` plus `ARK_PARTNER_API_TOKEN=<shared secret>`.
3. Add each sheet URL segment to **`ARK_UI_ROUTES`**. The site root **`/`** does not load a sheet by itself.

## Out of scope (v1)

- Formatting sync (`mergeCellStyle` stays client-side; the store has a style column reserved for later).
- Authoritative **locking** or merge conflict resolution (presence outlines are indicative only).
- Sheet history / restore endpoints (mutations are already recorded in the `sheet_events` log for a future version).

See [SPREADSHEET.md](SPREADSHEET.md) for grid behavior, undo, and column types.
