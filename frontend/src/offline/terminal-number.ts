/**
 * Till-side counter for per-terminal invoice numbers (PREFIX/YY/NNNNNN).
 * One metadata row per POS Profile. consumeNumber runs inside Dexie only,
 * so it can join the outbox enqueue transaction.
 */

import { assertWritable, db } from "./db";
import { deleteMetadata, getMetadata, setMetadata } from "./repos/metadata";

export interface FiscalYearRange {
	code: string;
	start: string;
	end: string;
}
export interface TerminalClaim {
	prefix: string | null;
	fiscal_years: FiscalYearRange[];
	last: Record<string, number>;
}
interface TerminalSeq {
	prefix: string;
	fiscal_years: FiscalYearRange[];
	counters: Record<string, { next: number; server_last: number }>;
}

export class TerminalNotReadyError extends Error {}

const key = (profile: string) => `terminal_seq:${profile}`;
const NUMBER_RE = /^([A-Z][A-Z0-9]{0,3})\/(\d{2})\/(\d{6})$/;

export function formatTerminalNumber(prefix: string, fy: string, n: number): string {
	return `${prefix}/${fy}/${String(n).padStart(6, "0")}`;
}

export function parseTerminalNumber(
	s: string | null | undefined,
): { prefix: string; fy: string; n: number } | null {
	const m = s ? NUMBER_RE.exec(s) : null;
	return m ? { prefix: m[1], fy: m[2], n: Number(m[3]) } : null;
}

export function fyCodeFor(fiscalYears: FiscalYearRange[], postingDate: string): string | null {
	return fiscalYears.find((f) => f.start <= postingDate && postingDate <= f.end)?.code ?? null;
}

export async function applyClaim(profile: string, claim: TerminalClaim): Promise<void> {
	if (claim.prefix === null) {
		await deleteMetadata(key(profile));
		return;
	}
	const prefix = claim.prefix;
	assertWritable();
	await db.transaction("rw", db.metadata, async () => {
		const old = await getMetadata<TerminalSeq>(key(profile));
		const same = old?.prefix === prefix;
		const counters: TerminalSeq["counters"] = {};
		for (const fy of claim.fiscal_years) {
			const prev = same ? old.counters[fy.code] : undefined;
			counters[fy.code] = {
				next: prev?.next ?? 1,
				server_last: Math.max(prev?.server_last ?? 0, claim.last[fy.code] ?? 0),
			};
		}
		await setMetadata<TerminalSeq>(key(profile), {
			prefix,
			fiscal_years: claim.fiscal_years,
			counters,
		});
	});
}

export async function forgetTerminal(profile: string): Promise<void> {
	await deleteMetadata(key(profile));
}

export async function currentNumber(profile: string, postingDate: string): Promise<string> {
	const row = await getMetadata<TerminalSeq>(key(profile));
	const fy = row && fyCodeFor(row.fiscal_years, postingDate);
	if (!row || !fy) throw new TerminalNotReadyError("Terminal numbering is not ready");
	const c = row.counters[fy] ?? { next: 1, server_last: 0 };
	return formatTerminalNumber(row.prefix, fy, Math.max(c.next, c.server_last + 1));
}

export async function consumeNumber(profile: string, number: string): Promise<void> {
	const p = parseTerminalNumber(number);
	if (!p) return;
	assertWritable();
	await db.transaction("rw", db.metadata, async () => {
		const row = await getMetadata<TerminalSeq>(key(profile));
		if (!row || row.prefix !== p.prefix) return;
		const c = row.counters[p.fy] ?? { next: 1, server_last: 0 };
		row.counters[p.fy] = { ...c, next: Math.max(c.next, p.n + 1) };
		await setMetadata(key(profile), row);
	});
}
