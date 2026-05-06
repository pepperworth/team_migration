# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`team-file-migration` is a local web tool for migrating files from Nextcloud into NBC (Niedersachsen.cloud) collaboration rooms. The entire app is two files: `server.js` (Node.js CORS proxy) and `public/index.html` (SPA). Zero dependencies — no `package.json`, no `npm install`, no build step. Node.js runtime is the only prerequisite.

## Commands

```bash
node server.js     # dev server → http://127.0.0.1:3210
bash deploy.sh     # deploy to production (scp + systemd restart)
```

There are **no test, lint, or build commands** — don't look for them. Deploy requires SSH access to the production host with the `nbc-migration` systemd service configured.

## Architecture

### server.js — CORS reverse proxy

Bare `http.createServer` (no Express). Exists solely so the browser SPA can reach external HTTPS APIs cross-origin. Route prefixes:

| Prefix | Target | Notes |
|---|---|---|
| `/proxy/nc-init/<encoded-base>/<path>` | Nextcloud | GET-only; initializes cookie session |
| `/proxy/nc/<encoded-base>/<path>` | Nextcloud | Uses cookie jar |
| `/proxy/nbc/<path>` | `https://niedersachsen.cloud` | Stateless (JWT passthrough) |
| `/proxy/nbc-custom/<encoded-base>/<path>` | Custom NBC domain | Stateless |

For `/proxy/nc/` and `/proxy/nbc-custom/`, the target base URL is URL-encoded and embedded as the first path segment after the prefix — not passed as a header or query param.

### public/index.html — SPA

Vanilla JS, no framework. All state lives in a single global object `S`:

```js
S = { jwt, baseUrl, roomId, filesStorageUrl, schoolId, boardId, columnId,
      files, ncConnected, ncBase, ncUser, ncPass, currentNcPath }
```

API helpers `nbcApi(path, opts)` (bearer JWT) and `ncApi(path, opts)` (Basic auth) both route through the local proxy.

**Migration workflow (4 steps):**

1. **NC credentials** — `testNextcloud()` validates via `/ocs/v1.php/cloud/user`
2. **NBC setup** — `ensureNbcSetup()` base64-decodes JWT to extract `schoolId`, then creates room/board/column
3. **Browse & select** — `ncBrowse()` uses WebDAV PROPFIND; `loadNcFilesRecursive()` walks up to 15 levels deep
4. **Migrate** — `startMigration()` per file: download from NC → create card → create file element → upload to Files Storage Service

### Hierarchy mapping (NC/legacy tree → NBC boards)

The arbitrarily deep source tree is flattened to **2 levels** in NBC. Per migration source, one board is created in the target room:

- **Board "Nextcloud-Dateien"** — built from the selected NC folder (`ncTree`).
- **Board "Alte Dateienablage"** — only created if the selected NC folder name contains a 24‑hex team‑id; then `legacyScanDir()` fetches the old Schul-Cloud files-storage tree (`legacyTree`).

Within each board:

- **Spalte "Übersicht"** — first column, holds an overview card (`createOverviewCard`) titled `📋 <root>` with a rich-text rendering of the full source tree as a nested list.
- **Spalte "Hauptordner"** — only if the root has loose files; one card with all root-level files attached via a single `fileFolder` element.
- **Spalte `<top-level-dir>`** — one column per top-level subfolder of the root. Inside that column, **every nested subfolder becomes its own card** (flattened by `processFolderFlat()` recursion), titled with the subfolder's name. Files within a folder are attached to that folder's card via a `fileFolder` element (one upload target per card, see `uploadFolderCard`).

Net effect: depth is preserved in card titles and the overview card's rich-text tree, but the kanban layout is always exactly two levels (column → card). Files only ever live on cards, never directly in columns.

### Authentication

- **Nextcloud**: HTTP Basic (username + app password)
- **NBC**: Bearer JWT (user pastes from browser; `schoolId` extracted via base64 decode of JWT payload)

## Key Conventions & Gotchas

- Port `3210` is hardcoded in `server.js` — not configurable via env. Server binds to `127.0.0.1` only.
- All proxy routes use `https.request` — will **not** work against HTTP-only Nextcloud instances.
- `cookieJar` is in-memory, keyed by NC base URL — all NC sessions are lost on server restart.
- `nbcProxy` is stateless; it only forwards whatever `Authorization` header the browser sends.
- `nc-init` must be called before regular `/proxy/nc/` requests to seed the cookie jar.
