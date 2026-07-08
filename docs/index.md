# Ark documentation

**Ark** is a spreadsheet with a **document-owning backend**: the Ark server (FastAPI + SQLite) stores the sheets, serves them to browsers, and persists every edit. In production you usually run Ark next to your own **partner** HTTP service: Ark verifies user tokens against it, sends it live **`sheet.changed`** notifications, and exposes a CRUD API so your backend can read and write sheets. The browser talks only to Ark — you do **not** need to expose your partner to the browser or deal with CORS.

## Start here: writing a partner

If you are integrating a backend with Ark, read **[Writing a partner](WRITING_A_PARTNER.md)** first. It walks through the two endpoints you provide (`/ark/auth`, `/ark/notify`), how URLs map to auto-created sheet documents, and how edits reach your server.

## Reference and deeper topics

| Document | Purpose |
| -------- | ------- |
| [Writing a partner](WRITING_A_PARTNER.md) | Step-by-step partner implementation |
| [Partner API](PARTNER_API.md) | Full contract: auth, notifications, CRUD API, WebSocket (includes **iframe framing** env vars) |
| [Spreadsheet behavior](SPREADSHEET.md) | Grid UX, column types, undo, toolbar |
| [Getting started](GETTING_STARTED.md) | Clone, Node, Python, Docker, first run |

## Published site

This documentation is built with [MkDocs](https://www.mkdocs.org/) and deployed to **GitHub Pages** when changes land on `main` (see `.github/workflows/pages.yml`).

- **Enable Pages:** in the GitHub repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
- **URL:** after the first successful deploy, the site is available at `https://<owner>.github.io/<repo>/` (for example `https://valteryde.github.io/ark/`).

## Source code

The Ark monorepo lives at [github.com/valteryde/ark](https://github.com/valteryde/ark).
