/**
 * Evidence log for the ticket's feasibility table. Each concurrency scenario
 * records WHAT WAS OBSERVED about an arrangement (not just pass/fail), so the
 * final table (Supported / Supported with restrictions / Unsupported safely /
 * Defect) is built from recorded facts. A prohibited-and-rejected flow is
 * "unsupported_safely", never "supported".
 *
 * Written to perf-results/evidence/<runId>.json (no credentials, no customer
 * data: only ids, counts and outcomes). Deliberately NOT under test-results/:
 * Playwright empties that folder at the start of every run, which would wipe
 * earlier scenarios' evidence before the feasibility table is built.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUN_ID } from "./manifest";

export type Outcome =
	| "supported"
	| "supported_with_restrictions"
	| "unsupported_safely"
	| "defect"
	| "observed";

export interface Evidence {
	id: string; // scenario id, e.g. CON-02
	arrangement: string;
	outcome: Outcome;
	notes: string[];
	data?: Record<string, unknown>;
}

export function recordEvidence(e: Evidence, dir = path.resolve("perf-results", "evidence")): string {
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${RUN_ID}.json`);
	const all: Evidence[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	all.push(e);
	writeFileSync(file, JSON.stringify(all, null, 2));
	return file;
}

/**
 * Collects results during a scenario so every check runs and all failures are
 * reported together. Two kinds are kept apart on purpose:
 *   problems - the test could not do its job (setup, selectors, timing)
 *   defects  - the APPLICATION behaved wrongly (a finding for the ticket)
 */
export class Findings {
	readonly problems: string[] = [];
	readonly defects: string[] = [];
	readonly notes: string[] = [];

	check(ok: boolean, problem: string) {
		if (!ok) this.problems.push(problem);
	}
	/** Record an application defect when `ok` is false. */
	expectSafe(ok: boolean, defect: string) {
		if (!ok) this.defects.push(defect);
	}
	note(n: string) {
		this.notes.push(n);
	}
}
