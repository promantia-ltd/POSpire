/**
 * Service Worker registration for POSpire.
 *
 * Wires `/sw.js` into the SPA under the following rules:
 *   - PROD builds only. Dev (`vite`) runs unregistered so HMR is unaffected.
 *   - Serves at root scope ('/') so it can cover /pospire/* and /app/* routes.
 *   - Never force-reloads on update. On `NEW_VERSION_AVAILABLE`, shows a
 *     non-blocking toast telling the cashier a reload will apply the update.
 *
 * If SW registration fails (CSP block, HTTP deployment, Service-Worker-Allowed
 * header missing), the SPA continues to work — offline shell just isn't
 * available on hard reloads. See docs/offline/10-service-worker.md §2.2.3.
 */

import { toast } from "vue3-toastify";
import { __ } from "@/utils/translate";

const SW_URL = "/sw.js";
const SW_SCOPE = "/";
let updateToastShown = false;

/**
 * Register the service worker. Safe to call multiple times (registration is
 * de-duplicated by the browser). No-op in dev or when SW is unsupported.
 */
export function registerServiceWorker() {
	if (!import.meta.env.PROD) {
		return Promise.resolve(null);
	}
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		// eslint-disable-next-line no-console
		console.warn("[pospire] Service Worker not supported in this browser");
		return Promise.resolve(null);
	}

	// Listen once for NEW_VERSION_AVAILABLE postMessages from the SW. Installing
	// this handler before register() guarantees we don't miss the message from
	// a SW that's already active on page load.
	if (!navigator.serviceWorker.__pospireMessageHandlerInstalled) {
		navigator.serviceWorker.addEventListener("message", handleSwMessage);
		navigator.serviceWorker.__pospireMessageHandlerInstalled = true;
	}

	return navigator.serviceWorker
		.register(SW_URL, { scope: SW_SCOPE })
		.then((registration) => {
			// When a new SW has finished installing and is waiting to activate,
			// surface the update toast. We don't auto-reload (P-3 / §5.4).
			registration.addEventListener("updatefound", () => {
				const installing = registration.installing;
				if (!installing) return;
				installing.addEventListener("statechange", () => {
					if (installing.state === "installed" && navigator.serviceWorker.controller) {
						showUpdateAvailableToast();
					}
				});
			});

			// Manual poll: Vite redeploys don't always fire `updatefound`
			// automatically when a tab has been open for a long time. An
			// occasional update() call is cheap and only hits the network if
			// the SW file's cache headers allow it.
			setTimeout(() => registration.update().catch(() => {}), 30_000);

			return registration;
		})
		.catch((err) => {
			// eslint-disable-next-line no-console
			console.warn("[pospire] Service Worker registration failed", err);
			return null;
		});
}

function handleSwMessage(event) {
	const data = event && event.data;
	if (!data || typeof data !== "object") return;
	if (data.type === "NEW_VERSION_AVAILABLE") {
		showUpdateAvailableToast();
	}
}

function showUpdateAvailableToast() {
	if (updateToastShown) return;
	updateToastShown = true;
	try {
		toast.info(__("Update available — reload to apply"), {
			autoClose: false,
			closeOnClick: false,
			position: "top-right",
		});
	} catch (err) {
		// Toast system not ready yet (called before app.use(Vue3Toastify)). Fall
		// back to a plain console message; the user will see the update on next
		// reload regardless.
		// eslint-disable-next-line no-console
		console.info("[pospire] Update available — reload to apply", err);
	}
}
