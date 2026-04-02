# Spreadsheet: backend-driven CRUD surface

## Why this exists

Ark’s spreadsheet is meant to sit **on top of any REST (or RPC) API**. The backend owns the data model, validation, and authorization; the frontend is a **generic grid** that renders whatever shape the API describes. A backend developer should be able to ship CRUD flows **without writing custom frontend code**: they expose configuration + HTTP endpoints, and the grid loads, edits, and saves through a thin adapter.

This document is the contract that both sides should align on.

## Architecture

1. **`SpreadsheetConfig`** — Declares columns (id, header, width, optional `displayStyle`, optional `readOnly` for system/computed columns shown darker and non-editable), row count, default row height, which **cell renderers** are allowed, and which **UI capabilities** the backend says are available (toolbar, future actions).
2. **`SpreadsheetDataStore`** — Synchronous get/set per `(row, col)`. **This is the seam for REST**: implement it by wrapping `fetch` (load page of rows into a cache, PATCH/PUT on commit, etc.). The default `createInMemoryDataStore()` is for demos and tests.
3. **Cell display styles** — Named renderers (`priority`, `status`, `assignee`, `plain`). The backend sends **`enabledCellStyles`**: if `priority` is not enabled, priority columns render as escaped plain text even if the column asks for `displayStyle: 'priority'`. That keeps presentation policy on the server.
4. **`enabledUiCapabilities`** — Optional set of toolbar/feature flags (undo, bold, filter, …). The shell can hide or disable controls based on this once wired; today it is the **documented contract** for future chrome.

## Data flow (REST mental model)

- **Read**: `GET /sheets/:id` or `GET /rows?offset=&limit=` → map response rows into `data.set(row, col, value)` (or a store that delegates to cached API state).
- **Write**: On cell commit (`persist`), `data.set` → your adapter calls `PATCH` with `{ fieldId, rowId, value }` derived from column `id` and row identity (you may add a parallel `rowIdByIndex` map from the API).
- **Schema**: Column `id` should match API field names so the adapter stays dumb.

## Security note

Rich cell HTML is built only from **known templates** + escaped user text. Do not pipe arbitrary server HTML into cells without a separate, explicit escape hatch and sanitization policy.

## API entrypoints (TypeScript)

- `mountSpreadsheet(container, config)` — Build the grid once.
- `createInMemoryDataStore(initial?)` — In-memory `row:col` map for prototyping.
- Presets (e.g. `createRoadmapPreset()`) — Example configs only; production should build config from JSON your API returns.

## Example API payload (schema only)

Your backend can return JSON that maps almost 1:1 to `SpreadsheetConfig` (minus `data`, which you implement client-side):

```json
{
  "rowCount": 100,
  "defaultRowHeightPx": 28,
  "enabledCellStyles": ["priority", "status", "assignee"],
  "enabledUiCapabilities": ["undo", "redo", "filter", "functions"],
  "columns": [
    { "id": "title", "header": "TASK NAME", "widthPx": 240, "displayStyle": "plain" },
    { "id": "priority", "header": "PRIORITY", "widthPx": 108, "displayStyle": "priority" }
  ]
}
```

Load row values with `GET`, fill a `SpreadsheetDataStore` implementation, then `mountSpreadsheet(el, { ...schemaFromApi, data: myStore })`.

## Evolution

- Async data store (`Promise` get/set) and partial virtualization.
- Server-sent `enabledCellStyles` / `enabledUiCapabilities` as JSON alongside column definitions.
- Row identities (`rowId`) in config for stable CRUD keys.
