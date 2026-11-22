/**
 * Single-run lock for the perf/concurrency suites.
 *
 * Two Playwright runs against the same site share the same seeded cashier
 * accounts and the same stock, so they corrupt each other: one run's shifts and
 * invoices show up in the other's checks, and the shared dev server slows both
 * past their timeouts. Instead of producing misleading results, a second run
 * stops immediately and says who holds the lock.
 *
 * Wired in via `globalSetup` in playwright.config.ts. The lock is a file with
 * the owner's pid; a lock whose process is gone (a crashed run) is taken over.
 * Set PERF_SKIP_LOCK=1 to bypass it deliberately.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_FILE = path.resolve("perf-results", "run.lock");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is not ours: still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Remove test-results/run-<pid> folders whose run is gone (each run writes to its own, see playwright.config.ts). */
function removeStaleRunDirs() {
	// outputDir in playwright.config.ts is resolved relative to the config file, not the cwd.
	const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-results");
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		const m = /^run-(\d+)$/.exec(name);
		if (m && Number(m[1]) !== process.pid && !isAlive(Number(m[1]))) {
			rmSync(path.join(root, name), { recursive: true, force: true });
		}
	}
}

export default async function globalSetup() {
	// One id for the whole invocation. Workers inherit it, so evidence/manifest files
	// are not split when Playwright restarts a worker after a failed test.
	process.env.PERF_RUN_ID ??= `run-${Date.now().toString(36)}`;
	if (process.env.PERF_SKIP_LOCK === "1") return;

	mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
	const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), argv: process.argv.slice(2).join(" ") });

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(LOCK_FILE, mine, { flag: "wx" }); // fails if it already exists
			removeStaleRunDirs();
			return async () => {
				try {
					if (JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid === process.pid) rmSync(LOCK_FILE);
				} catch {
					/* already gone */
				}
			};
		} catch {
			let holder: { pid?: number; startedAt?: string; argv?: string } = {};
			try {
				holder = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
			} catch {
				/* unreadable lock: treat as stale */
			}
			if (holder.pid && isAlive(holder.pid)) {
				throw new Error(
					`Another Playwright run is using this site (pid ${holder.pid}, started ${holder.startedAt}, args: "${holder.argv}").\n` +
						`Two runs share the same cashier accounts and stock and would corrupt each other. Wait for it to finish,\n` +
						`or set PERF_SKIP_LOCK=1 to run anyway.`,
				);
			}
			rmSync(LOCK_FILE, { force: true }); // stale lock from a crashed run: take over
		}
	}
	throw new Error(`Could not acquire ${LOCK_FILE}`);
}
