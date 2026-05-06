# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`team-file-migration` is a local web tool for migrating files from Nextcloud into NBC (Niedersachsen.cloud) collaboration rooms. The entire app is two files: `server.js` (Node.js CORS proxy) and `public/index.html` (SPA). Zero dependencies — no `package.json`, no `npm install`, no build step. Node.js runtime is the only prerequisite.

## Commands

```bash
node server.js     # dev server → http://127.0.0.1:3210
bash deploy.sh     # deploy to production (scp + systemd restart)
```

There are **no test, lint, or build commands** — don't look for them. Deploy requires SSH access to `root@217.160.189.48` with the `nbc-migration` systemd service configured; production URL is `https://migration.almostready.dev/`.

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

### Authentication

- **Nextcloud**: HTTP Basic (username + app password)
- **NBC**: Bearer JWT (user pastes from browser; `schoolId` extracted via base64 decode of JWT payload)

## Key Conventions & Gotchas

- Port `3210` is hardcoded in `server.js` — not configurable via env. Server binds to `127.0.0.1` only.
- All proxy routes use `https.request` — will **not** work against HTTP-only Nextcloud instances.
- `cookieJar` is in-memory, keyed by NC base URL — all NC sessions are lost on server restart.
- `nbcProxy` is stateless; it only forwards whatever `Authorization` header the browser sends.
- `nc-init` must be called before regular `/proxy/nc/` requests to seed the cookie jar.
