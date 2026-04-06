# Ark documentation

**Ark** is a configurable spreadsheet UI. In production you usually run Ark’s **BFF** (FastAPI) next to your own **partner** HTTP service. The browser talks only to Ark; Ark proxies to your API. You do **not** need to expose your partner to the browser or deal with CORS for sheet loads.

## Start here: writing a partner

If you are implementing the backend Ark calls, read **[Writing a partner](WRITING_A_PARTNER.md)** first. It walks through the two endpoints you provide, how URLs map to routes, and how edits reach your server.

## Reference and deeper topics

| Document | Purpose |
| -------- | ------- |
| [Writing a partner](WRITING_A_PARTNER.md) | Step-by-step partner implementation |
| [Partner API](PARTNER_API.md) | Full HTTP + tunnel + WebSocket contract |
| [Spreadsheet behavior](SPREADSHEET.md) | Grid UX, column types, undo, toolbar |
| [Getting started](GETTING_STARTED.md) | Clone, Node, Python, Docker, first run |

## Published site

This documentation is built with [MkDocs](https://www.mkdocs.org/) and deployed to **GitHub Pages** when changes land on `main` (see `.github/workflows/pages.yml`).

- **Enable Pages:** in the GitHub repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
- **URL:** after the first successful deploy, the site is available at `https://<owner>.github.io/<repo>/` (for example `https://valteryde.github.io/ark/`).

## Source code

The Ark monorepo lives at [github.com/valteryde/ark](https://github.com/valteryde/ark).
