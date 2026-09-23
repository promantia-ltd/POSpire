/**
 * POSpire Service Worker — shell-only (P-3)
 *
 * Responsibilities (see docs/offline/10-service-worker.md):
 *   1. Precache the compiled Vite app shell (HTML / JS / CSS / fonts / critical images)
 *      plus /offline.html on install.
 *   2. Serve shell assets cache-first with a background network revalidation.
 *   3. Serve navigation requests from the cached shell when offline; fall back to
 *      /offline.html when the shell isn't cached yet (first-ever visit offline).
 *   4. NEVER touch /api/method/* or /api/resource/* — those are Dexie's job.
 *   5. Version caches by build hash; never discard the working cache until the
 *      new versioned cache is fully installed.
 *   6. On successful activation, postMessage NEW_VERSION_AVAILABLE to every client.
 *
 * Hard constraints (P-3):
 *   - No API response caching here, ever. A failed API call surfaces to the
 *     offline adapter, which owns fallback semantics.
 *   - A failed precache MUST abort the install — the old cache stays live.
 *   - skipWaiting() only runs after the new cache is fully populated.
 */

/* eslint-env serviceworker */
/* global self, caches, clients, fetch, Response, URL */

// BUILD_HASH is substituted at build time. See scripts/inject-sw-build-hash.js
// (or the Vite plugin when one is wired). During local dev with Vite, the SW is
// NOT registered (main.js gates registration on import.meta.env.PROD), so the
// placeholder never reaches a live browser. If it does leak through, the
// `dev` sentinel below keeps behaviour sane instead of producing the literal
// string "__BUILD_HASH__" as a cache key.
const RAW_BUILD_HASH = "__BUILD_HASH__";
const BUILD_HASH =
	RAW_BUILD_HASH && RAW_BUILD_HASH !== "__BUILD" + "_HASH__" ? RAW_BUILD_HASH : "dev";

const SHELL_CACHE = `pospire-shell-v${BUILD_HASH}`;
const CACHE_PREFIX = "pospire-shell-v";
const OFFLINE_URL = "/offline.html";

// PRECACHE_URLS is the REQUIRED precache list — Vite assets (/assets/...) and
// /offline.html. A failure on any of these aborts install (these are the
// minimum we need to claim "shell-cached"). Substituted at build time.
const INJECTED_PRECACHE = "__PRECACHE_URLS__";
const PRECACHE_URLS = (() => {
	if (
		INJECTED_PRECACHE &&
		INJECTED_PRECACHE !== "__PRECACHE" + "_URLS__" &&
		INJECTED_PRECACHE.startsWith("[")
	) {
		try {
			const parsed = JSON.parse(INJECTED_PRECACHE);
			if (Array.isArray(parsed)) {
				return Array.from(new Set([OFFLINE_URL, ...parsed]));
			}
		} catch (err) {
			self.__SW_PRECACHE_PARSE_ERROR__ = err && err.message;
		}
	}
	return [OFFLINE_URL];
})();

// SHELL_ROUTES is the BEST-EFFORT precache list — the Frappe-rendered SPA
// shell routes (/pospire/pos etc.). These can fail (auth redirect, 4xx) at
// install time without aborting the install. Once a user successfully
// navigates online, handleNavigation caches the response too — but precaching
// here means hard-reload offline works without first having visited each
// route while online.
const INJECTED_SHELL_ROUTES = "__SHELL_ROUTES__";
const SHELL_ROUTES = (() => {
	if (
		INJECTED_SHELL_ROUTES &&
		INJECTED_SHELL_ROUTES !== "__SHELL" + "_ROUTES__" &&
		INJECTED_SHELL_ROUTES.startsWith("[")
	) {
		try {
			const parsed = JSON.parse(INJECTED_SHELL_ROUTES);
			if (Array.isArray(parsed)) return parsed;
		} catch (err) {
			self.__SW_SHELL_ROUTES_PARSE_ERROR__ = err && err.message;
		}
	}
	return ["/pospire/pos"];
})();

// SHELL_PATH_PREFIX is used by handleNavigation to find any cached SPA shell
// when the exact requested route isn't in cache. All /pospire/<x> routes
// route to the same Frappe template, so any cached one is interchangeable.
const SHELL_PATH_PREFIX = "/pospire";

// Paths the SW must never intercept. Passed through to network on every fetch.
const API_PASSTHROUGH_PREFIXES = ["/api/method/", "/api/resource/", "/api/v2/"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args) {
	// Use warn to survive default DevTools filters; SW logs are low-volume.
	// eslint-disable-next-line no-console
	console.warn("[pospire-sw]", ...args);
}

function isApiRequest(url) {
	return API_PASSTHROUGH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isNavigationRequest(request) {
	if (request.mode === "navigate") {
		return true;
	}
	// Fallback for older browsers: HTML documents requested at top level.
	return (
		request.method === "GET" &&
		request.headers.get("accept") &&
		request.headers.get("accept").includes("text/html")
	);
}

// POSpire assets whose filenames stay the same when their contents change.
// Frappe serves /assets with `immutable`, so a plain fetch can answer from the
// browser's HTTP cache and refill a freshly rotated shell cache with the old
// copy. `frontend` (Vite) and `dist` (Frappe bundle) filenames are hashed.
function isUnhashedAppAsset(url) {
	return (
		url.pathname.startsWith("/assets/pospire/") &&
		!url.pathname.startsWith("/assets/pospire/frontend/") &&
		!url.pathname.startsWith("/assets/pospire/dist/")
	);
}

function isShellAsset(url) {
	// Vite emits hashed assets under /assets/. We also accept common font
	// extensions and the root index.html.
	if (url.pathname === "/" || url.pathname.endsWith("/index.html")) {
		return true;
	}
	if (url.pathname.startsWith("/assets/")) {
		return true;
	}
	if (/\.(?:js|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|gif|webp|ico)$/.test(url.pathname)) {
		// Only treat app assets as shell — Frappe-served assets under
		// /files/ are user content and should pass through.
		if (!url.pathname.startsWith("/files/")) {
			return true;
		}
	}
	return false;
}

async function broadcastToClients(message) {
	try {
		const all = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
		for (const client of all) {
			client.postMessage(message);
		}
	} catch (err) {
		log("broadcast failed", err);
	}
}

// ---------------------------------------------------------------------------
// Install — build the new versioned cache. Abort on any failure; the old
// SW/cache stays live because we never touched it.
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(SHELL_CACHE);

			// REQUIRED precache — Vite assets + /offline.html. A failure here
			// aborts the install: these are the irreducible minimum.
			const results = await Promise.allSettled(
				PRECACHE_URLS.map(async (url) => {
					// Bypass HTTP cache so we grab the freshly-deployed asset.
					const req = new Request(url, { cache: "reload", credentials: "same-origin" });
					const res = await fetch(req);
					if (!res.ok) {
						throw new Error(`precache ${url} -> HTTP ${res.status}`);
					}
					await cache.put(url, res.clone());
				}),
			);

			const failures = results
				.map((r, i) => (r.status === "rejected" ? `${PRECACHE_URLS[i]}: ${r.reason}` : null))
				.filter(Boolean);

			if (failures.length) {
				await caches.delete(SHELL_CACHE);
				log("install failed — keeping previous cache intact", failures);
				throw new Error(`precache failed: ${failures.join("; ")}`);
			}

			// BEST-EFFORT precache — Frappe-rendered SPA shell routes. Without
			// these, hard-reload offline falls through to /offline.html (because
			// listReady doesn't include any /pospire/* HTML). With them, offline
			// navigation serves the cached shell and the SPA boots from the
			// already-cached Vite bundle.
			//
			// We tolerate failures here: Frappe might redirect to login if the
			// session cookie isn't present at install time, or the route might
			// not exist in some deployments. handleNavigation also caches on
			// successful navigation, so a failed precache is recoverable.
			const shellResults = await Promise.allSettled(
				SHELL_ROUTES.map(async (url) => {
					const req = new Request(url, { cache: "reload", credentials: "same-origin" });
					const res = await fetch(req);
					if (!res.ok) {
						throw new Error(`shell ${url} -> HTTP ${res.status}`);
					}
					if (res.type !== "basic") {
						throw new Error(`shell ${url} -> non-basic response (likely a redirect)`);
					}
					await cache.put(url, res.clone());
				}),
			);
			const shellFailures = shellResults
				.map((r, i) => (r.status === "rejected" ? `${SHELL_ROUTES[i]}: ${r.reason}` : null))
				.filter(Boolean);
			if (shellFailures.length) {
				log("shell precache best-effort partial:", shellFailures);
			}

			log("install complete", {
				cache: SHELL_CACHE,
				required: PRECACHE_URLS.length,
				shellRoutes: SHELL_ROUTES.length - shellFailures.length,
			});
			await self.skipWaiting();
		})(),
	);
});

// ---------------------------------------------------------------------------
// Activate — claim clients and prune OLD pospire caches. Never prune the
// current SHELL_CACHE even if it looks stale; the new SW only reaches
// activate() after install() wrote it, so by definition it's current.
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys();
			const oldShellCaches = names.filter(
				(name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE,
			);
			await Promise.all(oldShellCaches.map((name) => caches.delete(name)));

			await self.clients.claim();

			// Only signal an update when this SW actually replaced an older shell
			// cache. On first install there is no prior cache, so broadcasting
			// would surface a spurious "Update available" toast to the user.
			if (oldShellCaches.length > 0) {
				await broadcastToClients({
					type: "NEW_VERSION_AVAILABLE",
					buildHash: BUILD_HASH,
					cache: SHELL_CACHE,
				});
			}

			log("activate complete", {
				cache: SHELL_CACHE,
				replacedOldCaches: oldShellCaches.length,
			});
		})(),
	);
});

// ---------------------------------------------------------------------------
// Fetch — routing per docs/offline/10-service-worker.md §4.
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
	const { request } = event;

	// SW only handles GET. Non-GETs (POST for writes, etc.) always go to network.
	if (request.method !== "GET") {
		return;
	}

	let url;
	try {
		url = new URL(request.url);
	} catch {
		return;
	}

	// Never intercept cross-origin; let the browser handle it.
	if (url.origin !== self.location.origin) {
		return;
	}

	// P-3 non-negotiable: APIs always go to network, untouched.
	if (isApiRequest(url)) {
		return;
	}

	if (isNavigationRequest(request)) {
		event.respondWith(handleNavigation(request));
		return;
	}

	if (isShellAsset(url)) {
		event.respondWith(handleShellAsset(request));
		return;
	}

	// Everything else (Frappe /files/, /app routes we don't own, etc.): pass through.
});

async function handleNavigation(request) {
	// Network-first for navigations so the cashier sees fresh HTML when online.
	// On failure, fall back through (in order):
	//   1. The exact requested route, cached.
	//   2. ANY cached /pospire/* shell — all SPA routes return the same
	//      Frappe template, so any cached one boots the app correctly.
	//   3. /offline.html — last resort when no SPA shell is cached at all.
	try {
		const fresh = await fetch(request);
		// Opportunistically refresh the cached shell copy — but only for
		// successful, same-origin HTML responses.
		if (fresh && fresh.ok && fresh.type === "basic") {
			const cache = await caches.open(SHELL_CACHE);
			cache.put(request, fresh.clone()).catch(() => {
				/* cache quota or opaque response — safe to ignore */
			});
		}
		return fresh;
	} catch (err) {
		const cache = await caches.open(SHELL_CACHE);

		// 1. Exact match for the requested route.
		const cachedShell = await cache.match(request, { ignoreSearch: true });
		if (cachedShell) {
			log("nav offline — served cached shell (exact)", request.url);
			return cachedShell;
		}

		// 2. ANY cached /pospire/* shell. Walk the cache keys looking for a
		//    same-prefix navigation we previously stored (either via precache
		//    or a successful prior online visit).
		const requestedUrl = new URL(request.url);
		if (requestedUrl.pathname.startsWith(SHELL_PATH_PREFIX)) {
			const keys = await cache.keys();
			for (const cachedReq of keys) {
				let cachedUrl;
				try {
					cachedUrl = new URL(cachedReq.url);
				} catch {
					continue;
				}
				if (cachedUrl.origin !== self.location.origin) continue;
				if (!cachedUrl.pathname.startsWith(SHELL_PATH_PREFIX)) continue;
				if (cachedUrl.pathname === OFFLINE_URL) continue;
				const r = await cache.match(cachedReq);
				if (r) {
					log("nav offline — served fallback shell", {
						requested: request.url,
						served: cachedReq.url,
					});
					return r;
				}
			}
		}

		// 3. /offline.html — the SPA can't boot from this, but the user gets
		//    a real "you are offline" page instead of a connection error.
		const fallback = await cache.match(OFFLINE_URL);
		if (fallback) {
			log("nav offline — served /offline.html (no shell cached)", request.url);
			return fallback;
		}

		log("nav offline — no shell and no offline fallback", err);
		return new Response(
			"<!doctype html><title>Offline</title><p>You are offline. Please reconnect.</p>",
			{
				status: 503,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			},
		);
	}
}

async function handleShellAsset(request) {
	// Cache-first with background revalidation (stale-while-revalidate for the
	// shell). This is safe because Vite emits content-hashed filenames — a new
	// build produces new URLs, so stale cached copies can't shadow fresh code.
	//
	// ignoreSearch: the MDI CSS references fonts as
	//   materialdesignicons-webfont-HASH.woff2?v=7.4.47
	// but the precache stores them without the query string (Vite bundle
	// entries don't include the ?v= suffix). Without ignoreSearch:true the
	// cache.match is an exact-URL miss on every font request, so icons are
	// absent on any offline visit where background revalidation hasn't yet
	// had a chance to warm the ?v= variant. Vite assets are already
	// content-hashed in the filename, so query strings carry no identity
	// information and ignoring them is safe for all /assets/ paths.
	const cache = await caches.open(SHELL_CACHE);
	const cached = await cache.match(request, { ignoreSearch: true });

	// Skip the HTTP cache for unhashed app assets so a rotated shell cache is
	// refilled from the network, not from a superseded `immutable` response.
	const networkRequest = isUnhashedAppAsset(new URL(request.url))
		? new Request(request, { cache: "reload" })
		: request;

	const networkFetch = fetch(networkRequest)
		.then((res) => {
			if (res && res.ok && res.type === "basic") {
				cache.put(request, res.clone()).catch(() => {
					/* safe to drop */
				});
			}
			return res;
		})
		.catch((err) => {
			// If we have cached content, this is fine — swallow and let the
			// cached copy serve. Otherwise, bubble up so the browser shows a
			// network error, which is the honest answer.
			if (cached) {
				return null;
			}
			throw err;
		});

	if (cached) {
		// Kick off revalidation but don't block the response.
		networkFetch.catch(() => {
			/* already handled */
		});
		return cached;
	}

	return networkFetch;
}

// ---------------------------------------------------------------------------
// Message channel — lets the SPA ask the SW to skipWaiting on demand (manual
// "Update now" button in the offline admin panel per §5.4 of the spec).
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
	if (!event.data || typeof event.data !== "object") {
		return;
	}
	if (event.data.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
	if (event.data.type === "GET_VERSION") {
		if (event.source && typeof event.source.postMessage === "function") {
			event.source.postMessage({ type: "SW_VERSION", buildHash: BUILD_HASH });
		}
	}
});
