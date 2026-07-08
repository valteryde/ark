# Spreadsheet: backend-driven CRUD surface

## Why this exists

Ark’s spreadsheet is meant to sit **on top of any REST (or RPC) API**. The backend owns the data model, validation, and authorization; the frontend is a **generic grid** that renders whatever shape the API describes. A backend developer should be able to ship CRUD flows **without writing custom frontend code**: they expose configuration + HTTP endpoints, and the grid loads, edits, and saves through a thin adapter.

This document is the contract that both sides should align on.

## Architecture

1. **`SpreadsheetConfig`** — Declares columns (id, header, width, optional `readOnly` for system/computed columns shown darker and non-editable), optional **value typing** (`valueType`, `selectOptions`, `allowEmpty`), row count, default row height, which **UI capabilities** the backend says are available (toolbar, future actions), and optional **`growRowCountForPaste`** — when a paste would extend past the last row, the host can remount with a larger **`rowCount`** and replay the paste (partner shell uses this). **Ghost rows** (`ghostRowCount`): extra blank rows below the data area; selection and editing never move into them. **Ghost columns** (default on): the client adds non-data columns to the right until the grid fills the sheet viewport width (`ResizeObserver`); they are lighter than ghost rows, do not take focus, and are excluded from copy/paste, row selection width, and collab cell indices. Disable with `enableGhostColumns: false`, or tune `ghostColumnWidthPx` / `maxGhostColumns`. Embedders should call **`mountHandle.disconnectLayout?.()`** before removing the sheet container so the viewport observer is released.
2. **`SpreadsheetDataStore`** — Synchronous `get` / `set` per `(row, col)` plus optional **`getCellStyle(row, col)`** returning inline CSS as kebab-case keys (e.g. `{ "background-color": "#f5f5f5" }`) applied to the cell shell. **This is the seam for REST**: implement with `fetch`, cache, PATCH/PUT on commit, etc. The default **`createInMemoryDataStore(initial)`** accepts either a plain `string | number` or `{ value, style? }` per `"row:col"` key for demos and tests. For **undo/redo**, the in-memory store also implements **`hasCell`**, **`getStoredCell`**, and **`replaceCell(row, col, cell | null)`** (`null` removes the key). Custom adapters that omit these methods get **`historyEnabled: false`** on the mount handle; undo/redo shortcuts and toolbar actions stay inert.
3. **Select column chips** — For `valueType: 'select'`, each **`selectOptions`** entry can include optional **`color`**, **`backgroundColor`**, and **`icon`** (Phosphor icon name). The UI renders a small chip when any of these are present; see **[PARTNER_API.md](PARTNER_API.md)**.
4. **`enabledUiCapabilities`** — Optional set of toolbar/feature flags (undo, bold, fill, …). The shell hides or disables controls based on this; it is the **documented contract** for API payloads.

### Naming: `mergeCellStyle` vs toolbar

The data store’s **`mergeCellStyle`** (and the mount handle’s **`mergeCellStyleOnSelection`**) means **merge CSS property patches** onto a cell (bold, background, borders)—not “merge cells” spanning columns. There is **no** merge-cells spanning feature in v1.

### Toolbar behavior (v1)

- **Zoom** — The toolbar zoom control is interactive (50%–200%); it drives the mount handle’s `setZoom`/`getZoom`/`subscribeZoomChange` and scales the grid content only (popovers stay 1:1).
- **`functions`** — If listed in `enabledUiCapabilities`, the toolbar may show a **disabled** control (not implemented yet).
- **`link`** — Uses a browser **`prompt`** for URL entry; clearing the URL toggles underline styling. Document if you expose this capability to end users.
- **`comment`** — Requires `comment` in `enabledUiCapabilities` **and** a history-capable store (`getStoredCell` / `replaceCell`) for the comment UI to be active.

The demo app shell (tabs, header) is **not** part of the spreadsheet package; only the grid and toolbar are driven by config.

### Column value types (`valueType`)

- **`text`** (default) — Free text; commit stores the string as entered (no extra validation in v1).
- **`number`** — Commit accepts a trimmed string that parses to a finite number; empty string is allowed; invalid input is rejected and the editor reverts to the last stored value. Number cells are **right-aligned by default** (an explicit toolbar alignment overrides this per cell). A rejected commit shows a brief inline hint near the cell.
- **`select`** — Constrained to **`selectOptions`**: each entry is `{ "value": string, "label"?: string, "color"?: string, "backgroundColor"?: string, "icon"?: string }` (see PARTNER_API for chip fields). The store always holds the canonical **`value`**. The cell editor is still a text field; a **suggestion list** filters options as the user types (prefix then substring, case-insensitive). Editable select cells show a **dropdown caret** on hover/active; clicking it opens the full list. **Alt+ArrowDown** opens the full list. With the list open, **ArrowUp/ArrowDown** move the highlight, **Enter** applies the highlight (or commits the typed value if none), **Tab** applies the highlight or the first match, **Escape** closes the list. On commit, paste, or grid paste, a cell is accepted if it **exactly** matches an option’s **`value`**, or if it case-insensitively matches that option’s display string (`label`, or `value` when `label` is absent); otherwise the input is rejected and the editor reverts. **Copy** (cell, range, or copy row) puts the **display** string on the clipboard for select cells. If **`allowEmpty`** is `false`, an empty cell commits as the first option’s value (default `allowEmpty` is true).

Chip styling uses the canonical **`value`** to find the option; **`label`** is for display text when set.

## Data flow (REST mental model)

- **Read**: `GET /sheets/:id` or `GET /rows?offset=&limit=` → map response rows into `data.set(row, col, value)` (or a store that delegates to cached API state).
- **Write**: On cell commit (`persist`), `data.set` → your adapter calls `PATCH` with `{ fieldId, rowId, value }` derived from column `id` and row identity (you may add a parallel `rowIdByIndex` map from the API).
- **Schema**: Column `id` should match API field names so the adapter stays dumb.

## Security note

Rich cell HTML for select chips is built from **sanitized** `color` / `backgroundColor` strings, a restricted **`icon`** name, and **escaped** labels. Do not pipe arbitrary server HTML into cells without a separate, explicit escape hatch and sanitization policy.

## Keyboard / selection

The grid models two modes per cell, mirroring Google Sheets / Excel:

- **Navigation mode** is the default after any movement (arrow keys, click, Tab/Enter, Home/End, Page Up/Down). The active cell renders its formatted display (select chips, number formatting, styling), keyboard focus is on the viewport, and there is no caret. Copy (**Cmd/Ctrl+C**), paste (**Cmd/Ctrl+V**), and range selection (drag, Shift+Click, Shift+Arrow, Cmd/Ctrl+A) operate on the grid rather than on a focused text field.
- **Selection outline** — A multi-cell selection draws a solid accent border around the whole range; the active cell keeps a 2px inset border.
- **Truncation tooltip** — Hovering a cell whose text is clipped shows the full value as a native tooltip (the plain display text, matching Find).
- **Copy marquee** — After **Copy** or **Cut** (including **Copy row** from the context menu), a dashed animated outline marks the source range until you **paste**, press **Escape**, or copy/cut again. Selection can move independently while the marquee stays visible.
- **Edit mode** swaps the active cell to its `<input>` and gives it focus. Enter it with **F2**, **double-click**, or by typing a printable character (the character replaces the current value as the seed). **Backspace** with no range, on a populated cell, clears the cell and stays in navigation. **Escape** reverts a pending edit and returns to navigation; **Tab** / **Enter** commit the edit and move (Enter returns to the Tab-anchor column on the next row).
- **Select columns**: from navigation, **Alt+ArrowDown** opens the full options list (entering edit mode); from edit, the same shortcut and the typed-prefix suggestion list behave as before.

## Undo / redo

- **Gestures**: Each committed cell edit, range clear (**Backspace** with a multi-cell selection), and formatting change (toolbar applying CSS via `mergeCellStyle`) is one undo step. Fill color drags in the native picker are **batched** into one step per pick session.
- **Keyboard**: **Cmd+Z** / **Ctrl+Z** undo; **Cmd+Shift+Z** / **Ctrl+Shift+Z** redo; **Ctrl+Y** redo (Windows-style).
- **Handle**: `SpreadsheetMountHandle` exposes **`undo()`**, **`redo()`**, **`canUndo()`**, **`canRedo()`**, **`subscribeHistoryChange`**, **`runHistoryBatch`**, **`beginHistoryBatch`**, **`endHistoryBatch`**, **`historyEnabled`**, **`applyExternalValue`** (collab), **`replayClipboardPaste`** (same paste pipeline as native paste, for host-driven replay after row growth), and collab/persist helpers documented in TypeScript.

## Find in sheet

- **Behavior**: Search scans **data cells only** (`rowCount` × column count; not ghost rows/columns). Matching is **case-insensitive substring** on plain text as the user sees it: **select** columns use the same display string as the grid (**label** when present); **number** and **text** use trimmed string forms.
- **Navigation**: **Next** starts at the cell **after** the current selection in row-major order and **wraps**. **Previous** scans backward with wrap.
- **Bundled Ark app**: Header **Find in sheet** field, **Enter** = next match, **Shift+Enter** = previous, **Cmd+F** / **Ctrl+F** focuses the field. Browser page find is not used for cell values.
- **Embeds**: Use **`findInSheet({ query, forward })`** on the mount handle to drive your own UI; it returns whether a match was found and moves the selection + scrolls the match into view.

## Zoom

- **Handle**: `getZoom()`, `setZoom(factor)` (clamped 0.5–2, returns the applied value), and `subscribeZoomChange(cb)`. Zoom scales the grid content only; overlays/popovers stay 1:1. The bundled toolbar renders a zoom dropdown wired to these.

## Accessibility

- The viewport is `role="grid"` with `aria-rowcount`/`aria-colcount`; rows are `role="row"` with `aria-rowindex`, headers `role="columnheader"`, and cells `role="gridcell"` with `aria-rowindex`/`aria-colindex` (header row is index 1, data rows start at 2). The active cell carries `aria-selected`. A visually-hidden polite live region announces the active cell (`<header>, row <n>: <value|empty>`) as the selection moves via keyboard.

## Column sizing

- When **`columnWidthPersistenceKey`** is set, header resize grips are shown. **Drag** to resize; **double-click** a grip to **autofit** the column to its widest header/cell content. Widths are validated, clamped (48–800px), and persisted to `sessionStorage`.

## API entrypoints (TypeScript)

- `mountSpreadsheet(container, config)` — Build the grid once; returns a **`SpreadsheetMountHandle`** (apply CSS patches on selection, subscribe to selection changes, undo/redo when the store supports it) for `mountFormattingToolbar(toolbarEl, handle, resolveEnabledUiCapabilities(config.enabledUiCapabilities))`.
- `mountFormattingToolbar` — Renders toolbar controls from **`enabledUiCapabilities`**; styling actions call **`mergeCellStyle`** on the store (in-memory preset implements it).
- `createInMemoryDataStore(initial?)` — In-memory `row:col` map for prototyping.
- Presets (e.g. `createRoadmapPreset()`) — Example configs only; production should build config from JSON your API returns.

## Example API payload (schema only)

Your backend can return JSON that maps almost 1:1 to `SpreadsheetConfig` (minus `data`, which you implement client-side):

```json
{
  "rowCount": 100,
  "defaultRowHeightPx": 28,
  "enabledUiCapabilities": ["undo", "redo", "functions"],
  "columns": [
    { "id": "title", "header": "TASK NAME", "widthPx": 240 },
    {
      "id": "priority",
      "header": "PRIORITY",
      "widthPx": 108,
      "valueType": "select",
      "selectOptions": [
        {
          "value": "HIGH",
          "backgroundColor": "#d8f3dc",
          "color": "#1b4332",
          "icon": "arrow-up"
        }
      ]
    },
    {
      "id": "status",
      "header": "STATUS",
      "widthPx": 128,
      "valueType": "select",
      "selectOptions": [
        {
          "value": "In Progress",
          "backgroundColor": "#dbeafe",
          "color": "#1d4ed8",
          "icon": "circle-notch"
        },
        { "value": "Not Started" },
        { "value": "Completed" }
      ]
    }
  ]
}
```

Load row values with `GET`, fill a `SpreadsheetDataStore` implementation, then `mountSpreadsheet(el, { ...schemaFromApi, data: myStore })`.

The bundled Ark app uses the HTTP + WebSocket contract in **[PARTNER_API.md](PARTNER_API.md)** (one sheet per URL, payloads with `rows`, collab events).

## Evolution

Planned directions that fit Ark’s **backend-driven CRUD** model (no in-grid formulas):

1. **Insert/delete rows & columns** — reshape the grid with partner tunnel events (today: clear/delete row only).
2. **Fill handle / copy-down** — drag to repeat values or simple patterns (not formula propagation).
3. **Display formats** — currency, percent, date/time formatting on `number` / new column types while the API stores canonical values (numbers are right-aligned today).
4. **Freeze panes** — keep header row (and optional columns) visible while scrolling.
5. **Text wrap & row height resize** — clip/overflow/wrap per cell; user-resizable row heights (column autofit via double-click and truncation tooltips exist today).
6. **Sort & filter views** — UI sends view/query to the backend; server returns filtered row sets.
8. **Formatting persistence** — optional partner sync for `mergeCellStyle` (values and row delete are tunneled today).
9. **Multi-sheet workbook** — multiple tabs in one URL via nested `sheets[]` (partner mode is one sheet per path today).
10. **Stable row identity** — `rowId` in config so insert/delete/reorder do not rely on fragile row indices.

Also on the technical side: async data store (`Promise` get/set) and partial virtualization for large grids; server-sent `enabledUiCapabilities` alongside column definitions.
