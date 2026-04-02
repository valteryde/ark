# Spreadsheet: backend-driven CRUD surface

## Why this exists

Ark’s spreadsheet is meant to sit **on top of any REST (or RPC) API**. The backend owns the data model, validation, and authorization; the frontend is a **generic grid** that renders whatever shape the API describes. A backend developer should be able to ship CRUD flows **without writing custom frontend code**: they expose configuration + HTTP endpoints, and the grid loads, edits, and saves through a thin adapter.

This document is the contract that both sides should align on.

## Architecture

1. **`SpreadsheetConfig`** — Declares columns (id, header, width, optional `displayStyle`, optional `readOnly` for system/computed columns shown darker and non-editable), optional **value typing** (`valueType`, `selectOptions`, `allowEmpty`), row count, default row height, which **cell renderers** are allowed, and which **UI capabilities** the backend says are available (toolbar, future actions).
2. **`SpreadsheetDataStore`** — Synchronous `get` / `set` per `(row, col)` plus optional **`getCellStyle(row, col)`** returning inline CSS as kebab-case keys (e.g. `{ "background-color": "#f5f5f5" }`) applied to the cell shell. **This is the seam for REST**: implement with `fetch`, cache, PATCH/PUT on commit, etc. The default **`createInMemoryDataStore(initial)`** accepts either a plain `string | number` or `{ value, style? }` per `"row:col"` key for demos and tests. For **undo/redo**, the in-memory store also implements **`hasCell`**, **`getStoredCell`**, and **`replaceCell(row, col, cell | null)`** (`null` removes the key). Custom adapters that omit these methods get **`historyEnabled: false`** on the mount handle; undo/redo shortcuts and toolbar actions stay inert.
3. **Cell display styles** — Named renderers (`priority`, `status`, `assignee`, `plain`). The backend sends **`enabledCellStyles`**: if `priority` is not enabled, priority columns render as escaped plain text even if the column asks for `displayStyle: 'priority'`. That keeps presentation policy on the server.
4. **`enabledUiCapabilities`** — Optional set of toolbar/feature flags (undo, bold, fill, …). The shell hides or disables controls based on this; it is the **documented contract** for API payloads.

### Naming: `mergeCellStyle` vs toolbar

The data store’s **`mergeCellStyle`** (and the mount handle’s **`mergeCellStyleOnSelection`**) means **merge CSS property patches** onto a cell (bold, background, borders)—not “merge cells” spanning columns. There is **no** merge-cells spanning feature in v1.

### Toolbar behavior (v1)

- **`functions`** — If listed in `enabledUiCapabilities`, the toolbar may show a **disabled** control (not implemented yet).
- **`link`** — Uses a browser **`prompt`** for URL entry; clearing the URL toggles underline styling. Document if you expose this capability to end users.
- **`comment`** — Requires `comment` in `enabledUiCapabilities` **and** a history-capable store (`getStoredCell` / `replaceCell`) for the comment UI to be active.

The demo app shell (tabs, header) is **not** part of the spreadsheet package; only the grid and toolbar are driven by config.

### Column value types (`valueType`)

- **`text`** (default) — Free text; commit stores the string as entered (no extra validation in v1).
- **`number`** — Commit accepts a trimmed string that parses to a finite number; empty string is allowed; invalid input is rejected and the editor reverts to the last stored value.
- **`select`** — Constrained to **`selectOptions`**: each entry is `{ "value": string, "label"?: string }`. The store always holds the canonical **`value`**. The cell editor is still a text field; a **suggestion list** filters options as the user types (prefix then substring, case-insensitive). **Alt+ArrowDown** opens the full list. With the list open, **ArrowUp/ArrowDown** move the highlight, **Enter** applies the highlight (or commits the typed value if none), **Tab** applies the highlight or the first match, **Escape** closes the list. A value that does not match any option on commit is rejected and the editor reverts. If **`allowEmpty`** is `false`, an empty cell commits as the first option’s value (default `allowEmpty` is true).

Display styles (e.g. `status` pills) still use the canonical **`value`** for styling; **`label`** is only for showing a different string in the suggestion list and in the cell when provided.

## Data flow (REST mental model)

- **Read**: `GET /sheets/:id` or `GET /rows?offset=&limit=` → map response rows into `data.set(row, col, value)` (or a store that delegates to cached API state).
- **Write**: On cell commit (`persist`), `data.set` → your adapter calls `PATCH` with `{ fieldId, rowId, value }` derived from column `id` and row identity (you may add a parallel `rowIdByIndex` map from the API).
- **Schema**: Column `id` should match API field names so the adapter stays dumb.

## Security note

Rich cell HTML is built only from **known templates** + escaped user text. Do not pipe arbitrary server HTML into cells without a separate, explicit escape hatch and sanitization policy.

## Undo / redo

- **Gestures**: Each committed cell edit, range clear (**Backspace** with a multi-cell selection), and formatting change (toolbar applying CSS via `mergeCellStyle`) is one undo step. Fill color drags in the native picker are **batched** into one step per pick session.
- **Keyboard**: **Cmd+Z** / **Ctrl+Z** undo; **Cmd+Shift+Z** / **Ctrl+Shift+Z** redo; **Ctrl+Y** redo (Windows-style).
- **Handle**: `SpreadsheetMountHandle` exposes **`undo()`**, **`redo()`**, **`canUndo()`**, **`canRedo()`**, **`subscribeHistoryChange`**, **`runHistoryBatch`**, **`beginHistoryBatch`**, **`endHistoryBatch`**, and **`historyEnabled`**.

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
  "enabledCellStyles": ["priority", "status", "assignee"],
  "enabledUiCapabilities": ["undo", "redo", "functions"],
  "columns": [
    { "id": "title", "header": "TASK NAME", "widthPx": 240, "displayStyle": "plain" },
    { "id": "priority", "header": "PRIORITY", "widthPx": 108, "displayStyle": "priority" },
    {
      "id": "status",
      "header": "STATUS",
      "widthPx": 128,
      "displayStyle": "status",
      "valueType": "select",
      "selectOptions": [
        { "value": "In Progress" },
        { "value": "Not Started" },
        { "value": "Completed" }
      ]
    }
  ]
}
```

Load row values with `GET`, fill a `SpreadsheetDataStore` implementation, then `mountSpreadsheet(el, { ...schemaFromApi, data: myStore })`.

## Evolution

- Async data store (`Promise` get/set) and partial virtualization.
- Server-sent `enabledCellStyles` / `enabledUiCapabilities` as JSON alongside column definitions.
- Row identities (`rowId`) in config for stable CRUD keys.
