#!/usr/bin/env node
/**
 * Auto-detects this bench's site name and live dev-server port, then writes
 * (or updates) `tests/e2e/.env.test`'s `POSPIRE_E2E_BASE_URL` line.
 *
 * Why this is needed rather than a fixed value in `.env.test.example`: the
 * site name IS reliably readable from `sites/common_site_config.json`'s
 * `default_site`, but the PORT is not — `common_site_config.json`'s own
 * `webserver_port` says 8000 (the bench default), while this repo's actual
 * dev server is launched via `.vscode/launch.json`'s debug config on port
 * 8004 (a VSCode-specific setting, not a bench-standard one). There is no
 * single config file that reliably says "8004" — the only way to know which
 * port is actually live is to ask each candidate directly.
 *
 * Run: `node tests/e2e/setup-env.mjs`
 *
 * Only touches the BASE_URL line. USERNAME/PASSWORD/API_KEY/API_SECRET are
 * real secrets that can't be auto-detected — if `.env.test` doesn't exist
 * yet, this seeds it from `.env.test.example` first so those are still
 * present as placeholders to fill in by hand.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, ".env.test");
const ENV_EXAMPLE = path.resolve(__dirname, ".env.test.example");
// tests/e2e -> tests -> frontend -> pospire -> apps -> frappe-bench
const BENCH_ROOT = path.resolve(__dirname, "../../../../..");
const COMMON_SITE_CONFIG = path.join(BENCH_ROOT, "sites", "common_site_config.json");

function detectSiteName() {
	try {
		const config = JSON.parse(readFileSync(COMMON_SITE_CONFIG, "utf8"));
		if (config.default_site) return config.default_site;
	} catch (err) {
		console.warn(`[setup-env] Could not read ${COMMON_SITE_CONFIG}: ${err.message}`);
	}
	return null;
}

function candidatePorts() {
	const ports = new Set([8004]); // this repo's known VSCode-launch port
	try {
		const config = JSON.parse(readFileSync(COMMON_SITE_CONFIG, "utf8"));
		if (config.webserver_port) ports.add(config.webserver_port);
	} catch {
		// Already warned above if this failed.
	}
	ports.add(8000); // Frappe's own documented default, as a last resort
	return [...ports];
}

async function isLive(url) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
		clearTimeout(timeout);
		// Any response (even a redirect to /login) means a real server
		// answered — we're not checking auth here, just liveness.
		return res.status < 500;
	} catch {
		return false;
	}
}

async function detectBaseUrl() {
	const siteName = detectSiteName();
	const ports = candidatePorts();
	const hosts = siteName ? [`${siteName}.localhost`, "localhost"] : ["localhost"];

	for (const port of ports) {
		for (const host of hosts) {
			const url = `http://${host}:${port}`;
			console.log(`[setup-env] Probing ${url} ...`);
			if (await isLive(url)) {
				console.log(`[setup-env] Found a live server at ${url}`);
				return url;
			}
		}
	}
	return null;
}

function updateEnvFile(baseUrl) {
	if (!existsSync(ENV_FILE)) {
		if (!existsSync(ENV_EXAMPLE)) {
			throw new Error(`Neither ${ENV_FILE} nor ${ENV_EXAMPLE} exist.`);
		}
		copyFileSync(ENV_EXAMPLE, ENV_FILE);
		console.log(`[setup-env] Created ${ENV_FILE} from .env.test.example`);
	}

	const lines = readFileSync(ENV_FILE, "utf8").split("\n");
	let replaced = false;
	const updated = lines.map((line) => {
		if (line.startsWith("POSPIRE_E2E_BASE_URL=")) {
			replaced = true;
			return `POSPIRE_E2E_BASE_URL=${baseUrl}`;
		}
		return line;
	});
	if (!replaced) {
		updated.push(`POSPIRE_E2E_BASE_URL=${baseUrl}`);
	}
	writeFileSync(ENV_FILE, updated.join("\n"));
	console.log(`[setup-env] Set POSPIRE_E2E_BASE_URL=${baseUrl} in ${ENV_FILE}`);
}

function readExistingBaseUrl() {
	if (!existsSync(ENV_FILE)) return null;
	const match = readFileSync(ENV_FILE, "utf8").match(/^POSPIRE_E2E_BASE_URL=(.+)$/m);
	return match ? match[1].trim() : null;
}

// Don't overwrite an already-working BASE_URL just because a different-but-
// equally-valid host variant (e.g. the site vhost vs plain localhost) was
// probed first — only fill it in when it's missing or genuinely dead.
const existingBaseUrl = readExistingBaseUrl();
if (existingBaseUrl && (await isLive(existingBaseUrl))) {
	console.log(`[setup-env] Existing POSPIRE_E2E_BASE_URL=${existingBaseUrl} is already live — leaving it as-is.`);
	process.exit(0);
}

const baseUrl = await detectBaseUrl();
if (!baseUrl) {
	console.error(
		"[setup-env] Could not find a live server on any candidate port/host. " +
			"Is the bench running? Falling back to leaving BASE_URL untouched — " +
			"set POSPIRE_E2E_BASE_URL in .env.test manually.",
	);
	process.exit(1);
}
updateEnvFile(baseUrl);
console.log(
	"[setup-env] Done. Still fill in POSPIRE_E2E_USERNAME/PASSWORD/API_KEY/API_SECRET by hand in .env.test.",
);
