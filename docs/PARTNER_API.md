# Partner API contract

Ark’s browser app talks **same-origin** to the Ark BFF (`server/app/main.py`). The BFF proxies read routes to your service when **`ARK_BACKEND_URL`** is set. You implement the partner HTTP API on that base URL.

Ark is **one spreadsheet per browser URL**. There is **no bootstrap** and **no in-app tab navigation** between sheets: opening **`/clients`** loads that sheet only; **`/records`** is a separate page with its own grid. Link between them with normal HTML links if you want.

## Routes you implement

### `GET /ark/routing/{path}` (sheet payload)

The **first path segment** of the browser URL is `{path}` (e.g. **`/clients`** → `path` = `clients`). The UI calls **`GET /api/ark/routing/{path}`**, which proxies to **`GET {ARK_BACKEND_URL}/ark/routing/{path}`**.

Returns a **SheetPayload** used to build [`SpreadsheetConfig`](../src/spreadsheet/types.ts) and initial cell data.

**Flat shape** — `columns`, `rows`, etc. at the top level (see table).

**Nested shape** — Page-level `title` / `description` plus **`sheets`: `[{ title, columns, rows, rowCount, … }]`**. Ark normalizes using the first inner sheet and merges the outer `title` / `description` when useful (outer title wins for the header when both exist).

| Field | Required | Description |
|--------|----------|-------------|
| `title` | no | Shown in the header when present; also used for `document.title` |
| `description` | no | Informational |
| `columns` | yes* | Array of column objects (see below); *or supply via nested `sheets[0]` |
| `rows` | yes* | Array of row objects; keys should match column `id` |
| `sheets` | no | If present, first element supplies `columns` / `rows` / `rowCount` when top-level fields are omitted |
| `rowCount` | no | Default: at least `rows.length`, minimum 1 |
| `defaultRowHeightPx` | no | Passed through to config |
| `enabledCellStyles` | no | Subset of `plain` \| `priority` \| `status` \| `assignee` |
| `enabledUiCapabilities` | no | Toolbar flags (see SPREADSHEET.md) |

**Column object** (aligned with `SpreadsheetColumn`):

- `id` (string), `header` (string), `widthPx` (number)
- Optional: `displayStyle`, `readOnly`, `valueType`, `selectOptions`, `allowEmpty`

**Rows:** Each row is a plain object, e.g. `{ "id": 1, "name": "Acme" }`. Values are coerced to strings/numbers for cells. Missing keys become empty cells.

### `POST /ark/tunnel`

The BFF forwards mapped events when users edit the grid or when collab messages are processed. Implement persistence here.

**Shapes Ark sends** (after BFF mapping from WebSocket events):

- `{ "type": "update_cell", "row", "col", "columnId", "value", "meta" }` — cell value committed.
- `{ "type": "new_cell" | "delete_cell", "meta" }` — reserved for future events.
- `{ "type": "spreadsheet_event", "payload" }` — fallback.

**Client → BFF WebSocket** (browser sends JSON on `ws://…/ws/ark`):

- `{ "type": "cell.value_committed", "row", "col", "columnId", "value", "sheetPath"?: string, "clientId"?: string, "markerHue"?: number }` — primary edit event. **`sheetPath`** is the same routing suffix as the current page (e.g. `clients`). **`clientId`** lets the sender ignore its own echo. **`markerHue`** (0–360) drives a **brief tint** on the updated cell for remote peers.

The BFF **broadcasts** the same JSON to all connected clients and **`POST`s** the **mapped** body to `{ARK_BACKEND_URL}/ark/tunnel`.

## Browser URLs (SPA)

The Ark server serves `index.html` for each configured **single segment** so **`/clients`**, **`/records`**, etc. load the app. Set **`ARK_UI_ROUTES`** to a comma-separated list of those segments (letters/digits/hyphen only). Each segment must match a **`GET /ark/routing/{segment}`** you implement.

You may use a longer routing suffix (e.g. `api/clients`) if the URL path is still one segment under your hosting rules; the browser path’s first segment must be listed in **`ARK_UI_ROUTES`** and the full suffix is what Ark requests: `GET /api/ark/routing/{path}`.

## Local development

1. Run your partner API (e.g. `uvicorn example_api:app --port 9000`).
2. Set `ARK_BACKEND_URL=http://127.0.0.1:9000` for the Ark BFF.
3. Open Ark UI via the BFF (`uvicorn` serving `dist/`). No CORS issues: the browser only calls the BFF.
4. Open **`http://127.0.0.1:8000/clients`** or **`/records`** (add segments to **`ARK_UI_ROUTES`** for each sheet URL you support). The site root **`/`** does not load a sheet by itself.

## Out of scope (v1)

- Authoritative REST `PATCH` per row/cell (tunnel-only persistence is enough for the sample).
- Formatting-only tunnel events (`mergeCellStyle`) — value commits only in v1.
- Conflict resolution / presence on the WebSocket.

See [SPREADSHEET.md](SPREADSHEET.md) for grid behavior, undo, and column types.
