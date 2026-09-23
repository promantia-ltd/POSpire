# POSpire Service Worker

Scope: app shell only. **Never caches `/api/method/*`, `/api/resource/*`, or
`/api/v2/*`** (P-3 — non-negotiable). API response caching is the offline
adapter's job (Agent 1's Dexie repos), not the SW. See
`docs/offline/01-architecture-principles.md` (P-3) and
`docs/offline/10-service-worker.md` for the full spec.

## Files

| Path | Role |
|---|---|
| `frontend/public/sw.js` | Source SW. Contains placeholders `__BUILD_HASH__` and `__PRECACHE_URLS__` that the Vite plugin patches at build time. |
| `frontend/public/offline.html` | Minimal fallback page (no JS, no bundle). Served when navigation requests miss the cached shell. |
| `frontend/src/offline/registerServiceWorker.js` | Registers `/sw.js` at root scope in PROD only. Shows a non-blocking update toast on `NEW_VERSION_AVAILABLE`. |
| `frontend/vite-plugin-sw.js` | Build plugin: substitutes `BUILD_HASH` + precache URL list, then mirrors the patched `sw.js` and `offline.html` into `pospire/www/`. |
| `pospire/www/sw.js` | **Build artifact** (gitignored). Patched by the Vite plugin; served at `/sw.js` by Frappe's TemplatePage renderer. |
| `pospire/www/sw.py` | Header-only controller. Sets `Service-Worker-Allowed: /` and `Cache-Control: no-store`. Same canonical pattern as `frappe/www/website_script.py`. |
| `pospire/www/offline.html` | **Build artifact** (gitignored). Served at `/offline.html`; default `text/html` Content-Type from `mimetypes.guess_type` is correct, no `.py` companion needed. |

## How `BUILD_HASH` is injected

At `vite build` time, the plugin in `frontend/vite-plugin-sw.js`:

1. Walks the emitted bundle and assembles a precache URL list (every hashed
   JS/CSS chunk plus copied assets, scoped to the Vite `base` URL
   `/assets/pospire/frontend/`).
2. Computes a 12-char SHA-1 over the sorted URL list — that's `BUILD_HASH`.
   It changes whenever any shell file changes (Vite emits content-hashed
   filenames).
3. Replaces the placeholder strings `"__BUILD_HASH__"` and
   `"__PRECACHE_URLS__"` inside the emitted `sw.js`.
4. Mirrors the patched `sw.js` plus `offline.html` into `pospire/www/`.
   Path is anchored on `__dirname` (derived from `import.meta.url` because
   the plugin is ESM) — see `vite-plugin-sw.js:11`.

If placeholders are ever left unreplaced, the SW falls back to
`BUILD_HASH = "dev"` and `PRECACHE_URLS = ["/offline.html"]`. Registration
is gated on `import.meta.env.PROD` in `main.js` so this path normally only
appears in dev where SW registration is disabled anyway.

## How `/sw.js` is served at root scope

A Service Worker only controls URLs inside its own served path's directory
by default. Served from `/assets/pospire/frontend/sw.js`, it would only
control `/assets/pospire/frontend/*` — useless because the SPA mounts at
`/pospire/*`. So we serve the file at `/sw.js` (root).

**Mechanism: canonical Frappe www-page pattern.**

```
pospire/www/sw.js   ← patched JS (build artifact, gitignored)
pospire/www/sw.py   ← header-only companion controller
```

When the browser requests `/sw.js`, Frappe's `TemplatePage` resolver matches
`pospire/www/sw.js` exactly (see `template_page.py:78` —
`get_index_path_options` tries the bare path first). The companion `sw.py`
runs as a controller and sets:

* `Service-Worker-Allowed: /` — defensive; serving from `/sw.js` already
  defaults to root scope, but explicit is safer behind reverse proxies.
* `Cache-Control: no-cache, no-store, must-revalidate` — the SW source
  shouldn't be cached by the browser; the SW manages its own
  versioned-cache lifecycle.
* `no_cache = 1` — disables Frappe's Redis cache for the rendered page.

`Content-Type: application/javascript` is set automatically by
`frappe/website/utils.py:set_content_type` via `mimetypes.guess_type("/sw.js")`
— no override needed.

`hooks.py:website_route_rules` does NOT contain an entry for `/sw.js` or
`/offline.html`. Those rules route to website pages, not to whitelisted
RPC methods, so `to_route: "<dotted.api.method>"` would not dispatch.

## Update lifecycle

1. New build deployed. Browser fetches `/sw.js`, byte-compares against the
   installed SW; if different, installs.
2. On `install`, the new SW precaches under `pospire-shell-v{newHash}`. If
   any precache URL fails, install rejects and **the old cache stays live**.
3. On `activate`, caches whose name starts with `pospire-shell-v` and
   isn't the current one are deleted. The new SW `postMessage`s
   `NEW_VERSION_AVAILABLE` to all controlled clients.
4. `registerServiceWorker.js` listens for that message and shows a
   non-blocking toast "Update available — reload to apply". No auto-reload.

## Manual "Update now"

The SPA can postMessage `{ type: "SKIP_WAITING" }` to
`navigator.serviceWorker.controller` to force activation. Use for an admin
"Update now" action.

## Disabling SW (dev / debugging)

```js
navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
caches.keys().then(keys => keys.filter(k => k.startsWith("pospire-shell-v"))
  .forEach(k => caches.delete(k)));
```

## Verifying the chain locally

```bash
# 1. Build — the Vite plugin patches sw.js and writes to pospire/www/
cd frontend && npm run build

# 2. Restart so hooks.py + www/ files are picked up
cd .. && bench restart   # or `bench start` from the bench root

# 3. Confirm the response
curl -I http://localhost:8000/sw.js
#   HTTP 200, Content-Type: text/javascript, Service-Worker-Allowed: /, Cache-Control: no-store
curl -I http://localhost:8000/offline.html
#   HTTP 200, Content-Type: text/html

# 4. In the browser (POS app reloaded)
#    DevTools → Application → Service Workers
#    Should show sw.js registered at scope `/`, status: activated and is running
```

## Known gaps

- CSP: deployments with strict CSP need `worker-src 'self'`. If absent,
  registration silently fails. The deployment playbook must include this.
- No SW test harness yet; test matrix in `docs/offline/10-service-worker.md`
  §9 to cover before production rollout.
