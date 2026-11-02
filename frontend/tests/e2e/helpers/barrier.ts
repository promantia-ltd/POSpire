/**
 * Coordination for race tests. Raising Playwright's worker count does not
 * make transactions overlap; this does. Every actor prepares its action, calls
 * barrier.wait(), and all are released together. Request timing then proves
 * the overlap actually happened instead of assuming it.
 */

import { type Page, type Request } from "@playwright/test";

export class Barrier {
	private waiting: (() => void)[] = [];

	constructor(
		private readonly parties: number,
		private readonly timeoutMs = 60_000,
	) {}

	/** Resolves once `parties` callers have arrived; rejects if some never do. */
	wait(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Barrier timed out: ${this.waiting.length}/${this.parties} arrived`)),
				this.timeoutMs,
			);
			this.waiting.push(() => {
				clearTimeout(timer);
				resolve();
			});
			if (this.waiting.length === this.parties) {
				const release = this.waiting;
				this.waiting = [];
				release.forEach((r) => r());
			}
		});
	}
}

export interface Span {
	start: number;
	end: number;
}

/** Records the time window of every request on `page` whose URL matches `pattern`. */
export function trackRequests(page: Page, pattern: RegExp) {
	const open = new Map<Request, { start: number; url: string }>();
	const done: (Span & { url: string })[] = [];

	page.on("request", (r) => {
		if (pattern.test(r.url())) open.set(r, { start: performance.now(), url: r.url() });
	});
	const finish = (r: Request) => {
		const o = open.get(r);
		if (o) {
			done.push({ start: o.start, end: performance.now(), url: o.url });
			open.delete(r);
		}
	};
	page.on("requestfinished", finish);
	page.on("requestfailed", finish);

	return {
		/** First start to last end across every matching request. */
		span(): Span | null {
			if (done.length === 0) return null;
			return { start: Math.min(...done.map((d) => d.start)), end: Math.max(...done.map((d) => d.end)) };
		},
		urls: () => done.map((d) => d.url.split("/api/method/").pop() ?? d.url),
	};
}

/**
 * For fast requests (e.g. opening a shift) releasing two UI clicks together is
 * not enough: each request can finish before the other starts. This holds the
 * first matching request on every page at the network layer until ALL pages
 * have one pending, then continues them together.
 *
 * The span is measured from the moment each request is actually continued (not
 * from when it was issued, which would count the hold time and make any
 * overlap check vacuous) to when its response arrives.
 */
export async function releaseTogether(pages: Page[], pattern: RegExp, timeoutMs = 60_000) {
	const gate = new Barrier(pages.length, timeoutMs);
	const spans: Span[] = [];

	await Promise.all(
		pages.map((page) => {
			let released = false;
			return page.route(pattern, async (route) => {
				if (released) return route.continue(); // only the first request is synchronized
				released = true;
				await gate.wait();
				const start = performance.now();
				await route.continue();
				await route.request().response().catch(() => null);
				spans.push({ start, end: performance.now() });
			});
		}),
	);

	return {
		spans: () => [...spans],
		/** Common overlap in ms across all pages; -1 if some request never completed. */
		overlapMs: () => commonOverlapMs(spans.length === pages.length ? spans : [null]),
	};
}

/** Milliseconds during which ALL spans were in flight together (<= 0 means no common overlap). */
export function commonOverlapMs(spans: (Span | null)[]): number {
	if (spans.some((s) => s === null)) return -1;
	const real = spans as Span[];
	return Math.min(...real.map((s) => s.end)) - Math.max(...real.map((s) => s.start));
}
