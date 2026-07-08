# Partner + SQLite + Ark (minimal stack)

One **`docker compose`** brings up:

1. **`ark`** — This repository's image: the document backend. Sheets live in Ark's own SQLite (`/data/ark.db`, named volume); exposed on **http://localhost:8000**.
2. **`partner`** — FastAPI app on port **9000** (internal only) with its own **SQLite** at `/data/partner.db`. Implements [PARTNER_API.md](../../docs/PARTNER_API.md): **`GET /ark/auth`** (accepts all tokens), **`GET /ark/template/{path}`** (Ark pulls this when it first creates a document — columns, a template version, and the current SQLite rows as prefill), and **`POST /ark/notify`** (pulls the changed sheet from Ark and syncs it into SQLite).

## Run

```bash
cd examples/partner-sqlite-demo
docker compose up --build
```

Open **http://localhost:8000/clients** or **http://localhost:8000/records** (each URL is its own spreadsheet; **`/`** alone does not load a sheet). Edit a **Name** or **Client** cell — Ark persists it instantly and notifies the partner, which mirrors the change into its own SQLite. Type a name into the empty staging row: the partner inserts a database record and patches the generated **ID** back into the sheet live.

The Ark image defaults to **`ARK_UI_ROUTES=clients,records`** so those paths serve the SPA. Override to expose more sheet URLs.

## Local (no Docker) equivalent

Terminal A — partner:

```bash
cd examples/partner-sqlite-demo/partner
pip install -r requirements.txt
PARTNER_DB=./partner.db ARK_API_URL=http://127.0.0.1:8000 \
  ARK_PARTNER_API_TOKEN=demo-partner-token uvicorn main:app --port 9000
```

Terminal B — Ark (from repo root):

```bash
npm run build
ARK_PARTNER_BASE_URL=http://127.0.0.1:9000 ARK_PARTNER_API_TOKEN=demo-partner-token \
  uvicorn app.main:app --reload --app-dir server --port 8000
```

Open **http://127.0.0.1:8000/clients** (or **`/records`**), with **`ARK_UI_ROUTES=clients,records`** on the Ark server.

## Notes

- Ark is the system of record for the grid; the partner's SQLite is a synced mirror driven by `sheet.changed` notifications (notify → pull → upsert).
- **`id`** columns are read-only in the sheet; the partner uses them as `recordId`s and fills them in for new rows via `PATCH /api/partner/sheets/{path}`.
- Clearing a row in the grid deletes the mirrored record on the next sync.
- This is a teaching stack, not production hardening (any token accepted, single-file DBs, simple error handling).
