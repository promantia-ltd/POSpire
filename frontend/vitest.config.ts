/**
 * Vitest configuration for the POSpire offline test suite.
 *
 * Environment: happy-dom (lighter than jsdom, sufficient for Dexie + Vue).
 * Setup file installs fake-indexeddb so Dexie can open a real in-memory DB.
 *
 * The `@` alias mirrors vite.config.js so test imports look identical to
 * production code (`import ... from "@/offline/..."`).
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			// frappe-ui ships source with ESM-invalid relative imports (missing
			// file extensions) that break Node's ESM resolver. Tests don't
			// exercise frappe-ui's real networking anyway; stub it with a minimal
			// shim that returns never-resolving promises so unit tests exercising
			// the call() path will fall through to offline/cache/enqueue branches.
			"frappe-ui": path.resolve(__dirname, "__tests__/stubs/frappe-ui.ts"),
		},
		extensions: [".mjs", ".ts", ".js", ".mts", ".jsx", ".tsx", ".vue", ".json"],
	},
	test: {
		environment: "happy-dom",
		globals: true,
		setupFiles: ["./__tests__/setup.ts"],
		// Each test file gets a fresh module graph so the module-level caches
		// in crypto.ts / kill-switch.ts / outbox.ts don't leak across files.
		isolate: true,
		// Tests exercise real Dexie; even with fake-indexeddb this needs a
		// generous timeout on slower CI runners.
		testTimeout: 15_000,
		hookTimeout: 15_000,
		// Exclude the Playwright specs; they use a different runner.
		exclude: [
			"node_modules/**",
			"dist/**",
			"tests/e2e/**",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			include: ["src/offline/**", "src/stores/**", "src/utils/call.ts"],
			exclude: ["**/*.d.ts"],
		},
	},
});
