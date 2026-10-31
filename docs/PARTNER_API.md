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
- **`kind: "cell"`** — a committed cell value. `row`/`col` are 1-based grid indices; `columnId` matches the sheet's column config; `recordId` is the row's first read-only column value when present. Does not include style.
- **`kind: "cell_style"`** — a committed cell style. `style` is the full replacement object (`{}` means formatting was cleared). `row`, `col`, `columnId`, and `recordId` match `kind: "cell"`.
- **`kind: "row_deleted"`** — user deleted a grid row (cells cleared; rows are not shifted).
- **`kind: "sheet_created"`** — a sheet was auto-created on first visit; includes the `template` name/version it was built from (absent for blank sheets).

The notification is intentionally lightweight: when you need full state, pull the sheet with **`GET /api/partner/sheets/{path}`**. Notifications carry the editing user's `ark_token` as a Bearer header and are fire-and-forget (one retry); Ark never blocks the grid on your response.

## Ark's partner CRUD API (`/api/partner/…`)

All routes require **`Authorization: Bearer <ARK_PARTNER_API_TOKEN>`**.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/partner/sheets` | List sheets (`path`, `title`, `revision`, `updatedAt`). |
| `GET` | `/api/partner/sheets/{path}` | Full sheet document (same shape browsers get, plus `revision`). |
| `GET` | `/api/partner/sheets/{path}/pdf` | PDF of the stored sheet (`application/pdf`). Does not auto-create. |
| `PUT` | `/api/partner/sheets/{path}` | Create or fully replace a sheet. Open tabs remount live (`sheet.truth` push). |
| `PATCH` | `/api/partner/sheets/{path}` | Partial update: cells and/or metadata. Open tabs apply cell updates live without remounting. |
| `DELETE` | `/api/partner/sheets/{path}` | Delete the document. |
| `GET` | `/api/partner/audit-logs` | Query system audit logs across all sheets (filterable & paginated). |
| `GET` | `/api/partner/sheets/{path}/audit-logs` | Query audit logs for a specific sheet. |
| `GET` | `/api/partner/audit-logs/{id}` | Fetch a single audit log entry by ID. |

### `GET /api/partner/sheets/{path}/pdf`

Returns the stored sheet as a PDF attachment (`Content-Type: application/pdf`, `Content-Disposition: attachment`). The same file is what the header **Export PDF** button downloads from **`GET /api/sheets/{path}/pdf`** (browser `ark_token`, same auth as a sheet read).

| Status | When |
| ------ | ---- |
| **200** | PDF body, starting with `%PDF`. |
| **401** / **503** | Partner token missing or wrong (partner route). Browser route returns **401** when `/ark/auth` rejects the user. |
| **404** | No document at `{path}`. Neither route creates a sheet. |
| **403** | Browser route only, when the document has `pdfExport: false` (`{ "detail": "pdf_export_disabled" }`). |
| **413** | More than 10,000 data rows (`{ "detail": "pdf_too_large" }`). |

The file is landscape A4. It includes the sheet title (or the path), a repeating header row, and visible columns only (`hidden` columns are left out). Select cells print the option **label**. Link cells print the URL. Column widths follow `widthPx`. Empty rows between values stay; trailing empty `rowCount` padding does not. A cell that has a style and no value is still printed.

Painted cell styles are the toolbar declarations stored in `cellStyles`: `background-color`, `color` (`#rgb`, `#rrggbb`, `#rrggbbaa` with alpha dropped), bold (`font-weight` 600/700/`bold`/`bolder`), italic, underline, and strikethrough (`text-decoration-line` tokens), alignment (`justify-content`: `center`, `flex-end`/`end`, otherwise left — this overrides the default right alignment of number columns), and the toolbar border (`box-shadow: inset 0 0 0 1px #64748b`). Other CSS keys are ignored. A select option's `color` and `backgroundColor` are used when the cell has no style of its own for that property.

If a document's path is literally `{path}/pdf`, that URL returns the JSON document instead of a PDF of the parent, same collision rule as audit logs.

A successful download is audited as **`sheet.export`**.

### `GET /api/partner/audit-logs` (audit log query)

Ark maintains an immutable, tamper-evident audit log of every event across sheet documents, recording who accessed or mutated each sheet, timestamps, IP addresses, and detailed diffs (`oldValue` vs `newValue` for cell commits, cleared cells on row delete, etc.).

**Query Parameters:**
- `path` or `sheet_path` — filter by sheet path (e.g. `clients/21`).
- `prefix` — filter by sheet path prefix (e.g. `clients` matches `clients` and `clients/*`).
- `action` — filter by action type (`cell.update`, `cell.clear`, `cell.style`, `row.delete`, `sheet.create`, `sheet.replace`, `sheet.patch`, `sheet.delete`, `sheet.read`, `sheet.export`, `sheet.subscribe`, `auth.failed`, `cell.rejected`). Supports comma-separated list (e.g. `action=cell.update,row.delete`). `sheet.export` is a successful PDF download (`details.format` is `"pdf"`, `details.client` is `"partner_api"` or `"browser"`).
- `actor_type` — filter by actor category (`user`, `partner`, `system`).
- `actor_id` — filter by actor identity (e.g. browser `ark_token` or partner user ID).
- `since` / `from` — ISO 8601 timestamp floor (e.g. `2026-10-24T00:00:00Z`).
- `until` / `to` — ISO 8601 timestamp ceiling.
- `limit` — max items to return (1 to 1000, default 100).
- `offset` — pagination offset (default 0).
- `order` — sort order by creation time (`desc` or `asc`, default `desc`).

**Response format:**
```json
{
  "auditLogs": [
    {
      "id": 1,
      "sheetPath": "grades/math",
      "sheetId": 4,
      "action": "cell.update",
      "actorType": "user",
      "actorId": "student_token_123",
      "ipAddress": "192.168.1.50",
      "revision": 2,
      "details": {
        "row": 1,
        "col": 2,
        "columnId": "grade",
        "oldValue": "B",
        "newValue": "A"
      },
      "createdAt": "2026-10-24T08:30:00+00:00"
    }
  ],
  "total": 1,
  "limit": 100,
  "offset": 0
}
```

Optional partner request header:
- **`X-Actor-Id`** / **`X-Audit-Actor`** — When the partner app performs mutations via the CRUD API (`PUT`, `PATCH`, `DELETE`) on behalf of a specific user or admin, sending this header records their identity as the `actorId` in the audit trail.


### `PUT /api/partner/sheets/{path}` (create / replace)

Body is a sheet payload: **`columns`** (required), plus optional `rows`, `title`, `description`, `rowCount`, `ghostRowCount`, `defaultRowHeightPx`, `enabledUiCapabilities`, `chromeActions`, `cellStyles`, `pdfExport`. Field semantics are in the payload reference below. Rows are objects keyed by column `id`. `cellStyles` seeds per-cell formatting (see **Cell styles**). `pdfExport: false` turns off the in-app export button; omitting it leaves export on.

### `PATCH /api/partner/sheets/{path}` (partial update)

```json
{
  "title": "Optional new title",
  "rowCount": 200,
  "cells": [
    { "row": 1, "columnId": "name", "value": "Acme Corp" },
    { "recordId": 2, "columnId": "name", "value": "Beta LLC" },
    {
      "row": 3,
      "col": 2,
      "value": "Gamma",
      "style": { "background-color": "#fef3c7", "color": "#111827", "font-weight": "700" }
    },
    { "row": 4, "columnId": "name", "style": { "color": "#b91c1c" } }
  ]
}
```

Each cell update addresses a cell by **`row` + `columnId`**, **`recordId` + `columnId`** (row resolved through the first read-only column), or raw **`row` + `col`**. Include **`value`**, **`style`**, or both.

- An empty-string `value` clears the **value**. Formatting already on the cell is kept.
- Omit `style` to leave formatting unchanged. `style: null` or `style: {}` clears it. A style object **replaces** the cell's style (it is not merged).
- A cell with neither a value nor a style is deleted.
- A style-only update does not change the value. Open tabs apply value updates as `cell.value_committed` and style-only updates as `cell.style_committed`.

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
| `cellStyles` | Sparse per-cell styles keyed `"row:col"` (1-based). Present only when at least one cell has formatting. See **Cell styles**. |
| `defaultRowHeightPx` | Passed through to config |
| `enabledUiCapabilities` | Toolbar flags (see SPREADSHEET.md) |
| `pdfExport` | Present only as **`false`**, which hides the header **Export PDF** button and makes `GET /api/sheets/{path}/pdf` return **403**. Omitted means export is allowed. The partner route ignores this flag. |
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
| `valueType` | no | **`text`** (default), **`number`**, **`select`**, or **`link`**. Affects validation and editors. |
| `selectOptions` | no | When `valueType` is **`select`**, list of option objects (see below). |
| `allowEmpty` | no | On **`select`** columns: if `false`, committing empty uses the first option’s value. Default **`true`**. |
| `icon` | no | On **`link`** columns: [Phosphor](https://phosphoricons.com/) **regular** icon name (lowercase, hyphens). Default **`arrow-square-out`** (open in a new tab). Invalid names are ignored. |
| `label` | no | On **`link`** columns: text shown beside the icon. Omitted means the column **`header`** is shown. Blank header and label leave an icon-only button. |
| `openInNewTab` | no | On **`link`** columns: if **`false`**, the button navigates in the same tab. Default **`true`** (`target="_blank"`, `rel="noopener noreferrer"`). |

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

**Text and number columns** have no per-column display style enum. Formatting is per cell (`cellStyles`), not per column. Select chips (`color` / `backgroundColor` on an option) are separate: they follow the option, not the cell's own style.

#### Link columns (icon button)

Set **`valueType: "link"`** to render each cell as an icon with text beside it. The row value is the URL. **`label`** is the button text; if you omit it, the column **`header`** is shown next to the icon. Clicking the button (or pressing **Enter** on the cell) opens the URL. The grid does not edit these cells.

| Cell value | Result |
| ---------- | ------ |
| `https://…`, `http://…`, `mailto:…` | Button opens that URL |
| Path starting with `/` (for example `/records/12`) | Button opens that same-origin path |
| Empty, `javascript:`, `data:`, or `//…` | No button |

```json
{
  "id": "open",
  "header": "Open",
  "widthPx": 56,
  "valueType": "link",
  "icon": "arrow-square-out",
  "label": "Open record"
}
```

Omit **`icon`** for the same open-in-new glyph. Omit **`label`** to use the column header as the text. Set **`"openInNewTab": false`** when the URL should replace the current Ark page (another sheet path). When both header and label are blank, the button is icon-only and its accessible name is **`Open`**. A link column does not supply **`recordId`** unless you also mark it **`readOnly`**.

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

## Cell styles

Any cell can store presentation CSS. Styles survive refresh, partner `GET`/`PUT`/`PATCH`, and live collab. The toolbar (bold, italic, strikethrough, fill, text color, borders, alignment, link underline) writes this same object.

`cellStyles` is a map of **`"row:col"`** (1-based grid indices, same keys as sparse `cells`) to a style object. Keys use kebab-case CSS properties. Unknown properties and unsafe values are rejected or dropped so a payload cannot inject URLs or layout CSS.

| Property | Accepted values |
| -------- | ---------------- |
| `color`, `background-color`, `border-color` | Hex (`#rgb`, `#rrggbb`, `#rrggbbaa`), `rgb()` / `rgba()` with numeric channels, or a CSS color name such as `red` |
| `font-weight` | `normal`, `bold`, `bolder`, `lighter`, or `100`–`900` |
| `font-style` | `normal`, `italic`, `oblique` |
| `font-size` | `8px`–`96px` |
| `text-decoration-line` | `underline`, `line-through`, `overline`, `none` (space-separated) |
| `text-align` | `left`, `right`, `center`, `start`, `end`, `justify` |
| `justify-content`, `align-items` | `flex-start`, `center`, `flex-end`, `start`, `end`, and the other flex keywords the toolbar uses |
| `box-shadow` | `inset 0 0 0 1px` plus a color (the toolbar border) |
| `border-width` | `0px`–`8px` |
| `border-style` | `none`, `solid`, `dashed`, `dotted`, `double` |

Clearing a cell's **value** does not clear its style. Clearing the style (toolbar toggle off, or `style: {}`) removes those declarations. Deleting a row removes both. An empty cell that only has a style is kept and comes back as a `cellStyles` entry with no row value.

Browser edits send `{ "type": "cell.style_committed", "row", "col", "columnId", "style", "sheetPath", … }`. `style` is the full replacement object (`{}` clears). Ark stores it, broadcasts it, and enqueues a partner notification:

```json
{ "kind": "cell_style", "row": 1, "col": 2, "columnId": "name", "style": { "font-weight": "700" } }
```

`kind: "cell"` is still value-only. Pull `GET /api/partner/sheets/{path}` for the full `cellStyles` map. Templates may include `cellStyles` alongside `rows`.

## Browser-facing API (for reference)

- **`GET /api/sheets/{path}`** — sheet payload, auto-creating unknown paths. Requires a valid `ark_token` when `ARK_PARTNER_BASE_URL` is set.
- **WebSocket `/ws/ark`** — collab channel. Browsers send:
  - `{ "type": "cell.value_committed", "row", "col", "columnId", "value", "sheetPath", "clientId"?, "markerHue"?, "recordId"? }` — Ark persists the cell value (existing style is kept), bumps the revision, broadcasts to peers, and enqueues a partner notification. On a persistence failure only the sender receives `{ "type": "cell.persist_status", "ok": false, "row", "col", … }`.
  - `{ "type": "cell.style_committed", "row", "col", "columnId", "style", "sheetPath", "clientId"?, "markerHue"?, "recordId"? }` — Ark replaces that cell's style (`{}` clears it), broadcasts the sanitized style, and enqueues `kind: "cell_style"`. The cell value is unchanged. Read-only columns are rejected.
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

- Authoritative **locking** or merge conflict resolution (presence outlines are indicative only).
- Sheet history / restore endpoints (mutations are already recorded in the `sheet_events` log for a future version).

See [SPREADSHEET.md](SPREADSHEET.md) for grid behavior, undo, and column types.
