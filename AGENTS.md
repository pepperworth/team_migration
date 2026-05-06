# AGENTS.md

## Quick Facts

- Zero dependencies — no `package.json`, no `npm install`, no build step
- Entire app is two files: `server.js` (Node.js proxy) + `public/index.html` (SPA)
- Requires Node.js runtime only

## Commands

```bash
node server.js              # start dev server → http://127.0.0.1:3210 (localhost only, port hardcoded)
bash deploy.sh              # deploy to production (scp + systemd restart)
```

There are no test, lint, or build commands. Deploy requires SSH access to the production host with the `nbc-migration` systemd service configured.

## Architecture

**`server.js`** — bare `http.createServer` acting as CORS reverse proxy. No Express, no framework. Route prefix `/proxy/nc-init/` and `/proxy/nc/` forward to Nextcloud (with cookie jar keyed by NC base URL); `/proxy/nbc/` and `/proxy/nbc-custom/` forward to NBC APIs. Static files served from `public/`.

**`public/index.html`** — single vanilla-JS file, no framework. All state in global object `S`. API helpers `nbcApi()` and `ncApi()` both go through the local proxy.

## Key Conventions

- Port `3210` is hardcoded in `server.js:6` — not configurable via env
- All proxy routes use `https.request` (hardcoded HTTPS); will not work with HTTP-only Nextcloud instances
- NC proxy uses HTTP Basic auth + session cookies stored in-memory `cookieJar`; cookies lost on server restart
- NBC proxy is stateless — only passes through the `Authorization: Bearer <JWT>` header
- The `nc-init` route initializes a cookie session (GET only); regular `nc` proxy uses those cookies for subsequent requests
- URL-encoded NC base URL is embedded in the proxy path after the prefix (e.g. `/proxy/nc/<encoded-base-url>/path`)

## Migration Flow

1. User enters NC credentials → `testNextcloud()` validates via OCS API
2. User pastes NBC JWT → `ensureNbcSetup()` extracts `schoolId`, creates room/board/column
3. User browses NC files → `ncBrowse()` uses WebDAV PROPFIND; `loadNcFilesRecursive()` walks up to 15 levels
4. Migrate → `startMigration()`: download from NC → create card → create file element → upload to Files Storage Service

## Hierarchy mapping (source tree → NBC boards)

The deep source tree is flattened to **two levels** (column → card) per board:

- One board per source: `Nextcloud-Dateien` (from `ncTree`) and, if the selected NC folder name contains a 24‑hex team‑id, `Alte Dateienablage` (from `legacyTree` via `legacyScanDir`).
- First column `Übersicht` holds an overview card with a rich-text rendering of the full nested tree (`createOverviewCard`).
- Loose files at the root go into a `Hauptordner` column as a single card with a `fileFolder` element.
- Each top-level subfolder becomes its own column. **All nested subfolders inside it become individual cards in that same column** (flattened by `processFolderFlat`), each with a `fileFolder` element holding its files. Folder depth is preserved in card titles and the overview card, not in the kanban layout.
