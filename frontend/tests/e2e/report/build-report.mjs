#!/usr/bin/env node
/**
 * Builds the feasibility report from what the suite recorded.
 *
 *   node tests/e2e/report/build-report.mjs
 *
 * Inputs : perf-results/evidence/*.json  (what each scenario observed; latest COMPLETED run per id wins)
 *          tests/e2e/report/findings.json (the judgements: feasibility rows, defects, gaps; hand-written)
 * Outputs: perf-results/report/index.html      (self-contained: no network needed except web fonts)
 *          perf-results/report/measurements.json (every number charted, plus the evidence outcome per test)
 *
 * No dependencies. The charts are plain SVG; every chart has a table view and per-mark tooltips.
 * Colours are the Promantia brand palette only (Royal Blue primary series, Bright Orange secondary).
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const evidenceDir = path.join(root, "perf-results", "evidence");
const outDir = path.join(root, "perf-results", "report");
const findings = JSON.parse(readFileSync(path.join(here, "findings.json"), "utf8"));

const BLUE = "#143E9F";
const ORANGE = "#F47B2A";
const CREAM = "#F6E9CF";
const CHARCOAL = "#2F3542";
const GRAY = "#E6E8EC";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- evidence
function loadEvidence() {
	let files = [];
	try {
		files = readdirSync(evidenceDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ f, t: statSync(path.join(evidenceDir, f)).mtimeMs }))
			.sort((a, b) => a.t - b.t);
	} catch {
		return { latest: new Map(), runs: new Map() };
	}
	const latest = new Map();
	const runs = new Map();
	for (const { f } of files) {
		for (const e of JSON.parse(readFileSync(path.join(evidenceDir, f), "utf8"))) {
			const complete = !(e.notes ?? []).some((n) => n.includes("DID NOT COMPLETE"));
			runs.set(e.id, (runs.get(e.id) ?? 0) + 1);
			if (complete || !latest.has(e.id)) latest.set(e.id, { ...e, complete, file: f });
		}
	}
	return { latest, runs };
}
const { latest, runs } = loadEvidence();
const get = (id, pick) => {
	try {
		const v = pick(latest.get(id)?.data ?? {});
		return typeof v === "number" ? v : null;
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------- outcome vocabulary
const OUTCOMES = {
	supported: { label: "Supported", icon: "✔", cls: "b-supported", rank: 0 },
	supported_with_restrictions: { label: "Supported with restrictions", icon: "!", cls: "b-restricted", rank: 1 },
	unsupported_safely: { label: "Unsupported, safely", icon: "⊘", cls: "b-unsupported", rank: 1 },
	defect: { label: "Defect", icon: "✖", cls: "b-defect", rank: 2 },
	observed: { label: "Incomplete", icon: "…", cls: "b-incomplete", rank: 3 },
};
const badge = (o) => `<span class="badge ${OUTCOMES[o].cls}"><span aria-hidden="true">${OUTCOMES[o].icon}</span> ${OUTCOMES[o].label}</span>`;

// ---------------------------------------------------------------- consistency check
const warnings = [];
for (const row of findings.feasibility) {
	for (const t of row.tests) {
		const ev = latest.get(t);
		if (!ev) {
			warnings.push(`${t}: no recorded evidence for "${row.area}"`);
			continue;
		}
		if (!ev.complete) warnings.push(`${t}: latest evidence is incomplete`);
		else if (!row.sharedEvidence && OUTCOMES[ev.outcome].rank > OUTCOMES[row.outcome].rank) {
			warnings.push(`${t}: evidence says ${ev.outcome}, worse than the stated "${row.outcome}" for "${row.area}"`);
		}
	}
}

// ---------------------------------------------------------------- charts
const fmt = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));
/** A round axis maximum: 4 equal steps of 1, 2, 2.5, 5 or 10 (times a power of ten). */
function niceTop(max) {
	const raw = max / 4;
	const pow = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((v) => v >= raw);
	return step * 4;
}

/** Grouped vertical bars. series: [{name,color,values}], categories: [string], unit: "s" */
function groupedBars({ id, categories, series, unit, yLabel }) {
	const W = 680, H = 300, L = 56, R = 16, T = 24, B = 46;
	const max = Math.max(...series.flatMap((s) => s.values.filter((v) => v != null)), 1);
	const top = niceTop(max);
	const iw = W - L - R, ih = H - T - B;
	const gw = iw / categories.length;
	const bw = Math.min(46, (gw - 28) / series.length);
	const y = (v) => T + ih - (v / top) * ih;
	let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}" class="chart">`;
	for (let i = 0; i <= 4; i++) {
		const v = (top / 4) * i;
		svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${GRAY}" stroke-width="1"/>`;
		svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">${fmt(v)}</text>`;
	}
	svg += `<text x="12" y="${T + ih / 2}" transform="rotate(-90 12 ${T + ih / 2})" text-anchor="middle" class="axis">${esc(yLabel)}</text>`;
	categories.forEach((c, ci) => {
		const gx = L + gw * ci + gw / 2;
		series.forEach((s, si) => {
			const v = s.values[ci];
			if (v == null) return;
			const x = gx - (bw * series.length + 4 * (series.length - 1)) / 2 + si * (bw + 4);
			const h = Math.max(1, (v / top) * ih);
			const tip = `${s.name}, ${c}: ${fmt(v)} ${unit}`;
			svg += `<path d="M${x},${y(v) + h} v-${Math.max(0, h - 4)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${Math.max(0, h - 4)} z" fill="${s.color}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></path>`;
			svg += `<text x="${x + bw / 2}" y="${y(v) - 6}" text-anchor="middle" class="val">${fmt(v)}</text>`;
		});
		svg += `<text x="${gx}" y="${H - 18}" text-anchor="middle" class="cat">${esc(c)}</text>`;
	});
	svg += `</svg>`;
	const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
	const table = `<details class="tableview"><summary>Table view</summary><table><thead><tr><th></th>${series.map((s) => `<th>${esc(s.name)} (${unit})</th>`).join("")}</tr></thead><tbody>${categories
		.map((c, ci) => `<tr><th scope="row">${esc(c)}</th>${series.map((s) => `<td>${s.values[ci] == null ? "n/a" : fmt(s.values[ci])}</td>`).join("")}</tr>`)
		.join("")}</tbody></table></details>`;
	return `<figure id="${id}">${legend}${svg}${table}</figure>`;
}

/** Single-series horizontal bars. rows: [{label, value}] */
function hBars({ id, rows, unit, color = BLUE, xLabel }) {
	const rowsOk = rows.filter((r) => r.value != null);
	const W = 760, LBL = 340, R = 56, rowH = 30, T = 8, B = 44;
	const H = T + rowsOk.length * rowH + B;
	const max = Math.max(...rowsOk.map((r) => r.value), 1);
	const top = niceTop(max);
	const iw = W - LBL - R;
	let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xLabel)}" class="chart">`;
	for (let i = 0; i <= 4; i++) {
		const v = (top / 4) * i;
		const x = LBL + (v / top) * iw;
		svg += `<line x1="${x}" x2="${x}" y1="${T}" y2="${H - B + 4}" stroke="${GRAY}"/><text x="${x}" y="${H - B + 18}" text-anchor="middle" class="axis">${fmt(v)}</text>`;
	}
	svg += `<text x="${LBL + iw / 2}" y="${H - 4}" text-anchor="middle" class="axis">${esc(xLabel)}</text>`;
	rowsOk.forEach((r, i) => {
		const y = T + i * rowH + 5;
		const w = Math.max(2, (r.value / top) * iw);
		const tip = `${r.label}: ${fmt(r.value)} ${unit}`;
		svg += `<text x="${LBL - 10}" y="${y + 13}" text-anchor="end" class="cat">${esc(r.label)}</text>`;
		svg += `<path d="M${LBL},${y} h${w - 4} a4,4 0 0 1 4,4 v12 a4,4 0 0 1 -4,4 h-${w - 4} z" fill="${color}" tabindex="0" data-tip="${esc(tip)}"><title>${esc(tip)}</title></path>`;
		svg += `<text x="${LBL + w + 8}" y="${y + 14}" class="val" text-anchor="start">${fmt(r.value)}</text>`;
	});
	svg += `</svg>`;
	const table = `<details class="tableview"><summary>Table view</summary><table><thead><tr><th>Scenario</th><th>${esc(xLabel)}</th></tr></thead><tbody>${rowsOk
		.map((r) => `<tr><th scope="row">${esc(r.label)}</th><td>${fmt(r.value)}</td></tr>`)
		.join("")}</tbody></table></details>`;
	return `<figure id="${id}">${svg}${table}</figure>`;
}

const sec = (ms) => (ms == null ? null : ms / 1000);
const measurements = { generatedFrom: "perf-results/evidence (latest completed run per test id)", tests: {} };

// Chart 1: CON-06 submit latency vs cashiers
const burstIds = ["CON-06 (10)", "CON-06 (25)", "CON-06 (50)"];
const burst = burstIds.map((id) => ({
	id,
	n: Number(id.match(/\((\d+)\)/)[1]),
	p50: sec(get(id, (d) => d.submit.p50_ms)),
	p95: sec(get(id, (d) => d.submit.p95_ms)),
	max: sec(get(id, (d) => d.submit.max_ms)),
	throughput: get(id, (d) => d.submit.throughput_per_s),
	draftP50: sec(get(id, (d) => d.createDraft.p50_ms)),
	draftP95: sec(get(id, (d) => d.createDraft.p95_ms)),
}));
measurements.burst = burst;
const chart1 = groupedBars({
	id: "chart-burst",
	categories: burst.map((b) => `${b.n} cashiers`),
	series: [
		{ name: "Median (p50)", color: BLUE, values: burst.map((b) => b.p50) },
		{ name: "95th percentile (p95)", color: ORANGE, values: burst.map((b) => b.p95) },
	],
	unit: "s",
	yLabel: "Submit time (seconds)",
});

// Chart 2: OFF-06 online cashier while others drain
const aT = latest.get("OFF-06")?.data?.aTiming;
measurements.onlineCashierDuringDrain = aT ?? null;
const chart2 = aT
	? groupedBars({
			id: "chart-isolation",
			categories: [`Before the drain (${aT.baseline.n} sales)`, `During the drain (${aT.during.n} sales)`],
			series: [
				{ name: "Median (p50)", color: BLUE, values: [aT.baseline.median / 1000, aT.during.median / 1000] },
				{ name: "95th percentile (p95)", color: ORANGE, values: [aT.baseline.p95 / 1000, aT.during.p95 / 1000] },
			],
			unit: "s",
			yLabel: "Sale submit time (seconds)",
		})
	: "<p>No OFF-06 timing recorded.</p>";

// Chart 3: time for offline queues to settle after reconnecting (fault-free scenarios)
const drainRows = [
	{ label: "OFF-01a  2 devices × 5 bills", id: "OFF-01a", v: get("OFF-01a", (d) => d.fullDrainMs) },
	{ label: "OFF-01b  2 devices × 5 bills, 2 warehouses", id: "OFF-01b", v: get("OFF-01b", (d) => d.fullDrainMs) },
	{ label: "OFF-02a  2 devices × 4 bills, one shift, together", id: "OFF-02a", v: get("OFF-02a", (d) => d.totalDrainMs) },
	{ label: "OFF-02b  same, A then B", id: "OFF-02b", v: get("OFF-02b", (d) => d.totalDrainMs) },
	{ label: "OFF-02c  same, B then A", id: "OFF-02c", v: get("OFF-02c", (d) => d.totalDrainMs) },
	{ label: "OFF-04  chain of 6 queued actions + 3 bills", id: "OFF-04", v: get("OFF-04", (d) => d.drain.totalMs) },
	{ label: "OFF-06  B: 4 bills + closing", id: "OFF-06", v: get("OFF-06", (d) => d.settleMs.B) },
	{ label: "OFF-06  C: 4 bills", id: "OFF-06", v: get("OFF-06", (d) => d.settleMs.C) },
].map((r) => ({ ...r, value: sec(r.v) }));
measurements.offlineDrainSeconds = Object.fromEntries(drainRows.map((r) => [r.label.replace(/\s+/g, " "), r.value]));
const chart3 = hBars({ id: "chart-drain", rows: drainRows, unit: "s", xLabel: "Seconds from reconnect until the queue settled" });

for (const [id, e] of latest) measurements.tests[id] = { outcome: e.outcome, complete: e.complete, recordedRuns: runs.get(id), evidenceFile: e.file };
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "measurements.json"), JSON.stringify(measurements, null, 2));

// ---------------------------------------------------------------- page
const counts = {};
for (const r of findings.feasibility) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
const m = findings.meta;
const ul = (xs) => `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

const feasRows = findings.feasibility
	.map(
		(r) => `<tr>
<td>${esc(r.area)}</td><td>${esc(r.mode)}</td><td>${badge(r.outcome)}</td>
<td class="small">${esc(r.note)}${r.sharedEvidence ? ` <em>${esc(r.sharedEvidence)}</em>` : ""}</td>
<td class="small">${r.tests.map((t) => `<span class="tid" title="${esc(latest.get(t)?.arrangement ?? "")}">${esc(t)}</span>`).join(" ")}</td></tr>`,
	)
	.join("");

const defectCards = findings.defects
	.map(
		(d) => `<article class="defect" id="${d.id}">
<h3><span class="did">${d.id}</span> ${esc(d.title)}</h3>
<p class="meta">${badge("defect")} <span class="sev">Severity: ${esc(d.severity)}</span> · Evidence: ${d.tests.map((t) => `<span class="tid">${esc(t)}</span>`).join(" ")}</p>
<p><strong>What happens.</strong> ${esc(d.what)}</p>
<p><strong>Impact.</strong> ${esc(d.impact)}</p>
<p><strong>How to reproduce.</strong></p><ol>${d.repro.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<p><strong>Likely cause.</strong> ${esc(d.likelyCause)}</p>
<p class="decision"><strong>Decision needed.</strong> ${esc(d.decision)}</p>
</article>`,
	)
	.join("");

const chips = Object.entries(OUTCOMES)
	.filter(([k]) => counts[k])
	.map(([k, v]) => `<span class="chip">${badge(k)} <b>${counts[k]}</b></span>`)
	.join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Montserrat:wght@600;700&display=swap">
<style>
:root{--blue:${BLUE};--orange:${ORANGE};--cream:${CREAM};--ink:${CHARCOAL};--line:${GRAY};--white:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--white);color:var(--ink);font:15px/1.55 Inter,Calibri,Arial,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
header.top{background:var(--cream);border-bottom:1px solid var(--line)}
.logo{padding:18px 0 0}.logo b{font:700 22px Montserrat,Calibri,sans-serif;color:var(--blue);letter-spacing:.04em}.logo span{display:block;font:600 11px Inter,Arial,sans-serif;color:var(--orange)}
h1{font:700 34px/1.15 Montserrat,Calibri,sans-serif;color:var(--blue);margin:18px 0 4px}
h2{font:700 24px Montserrat,Calibri,sans-serif;color:var(--blue);margin:44px 0 6px}
h2::after{content:"";display:block;width:56px;height:3px;background:var(--orange);margin-top:8px}
h3{font:600 18px Montserrat,Calibri,sans-serif;color:var(--blue);margin:0 0 6px}
.sub{color:var(--ink);margin:0 0 14px;font-size:17px}
.facts{display:flex;flex-wrap:wrap;gap:6px 22px;padding:0 0 20px;font-size:13px}.facts b{color:var(--blue)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.cols{grid-template-columns:1fr}}
.card{background:#fff;border:1px solid var(--line);border-radius:4px;padding:16px 18px}
.card.alert{border-left:4px solid var(--orange)}.card.ok{border-left:4px solid var(--blue)}
.card h3{margin-bottom:8px}.card ul{margin:0;padding-left:20px}.card li{margin:0 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 14px}.chip b{margin-left:4px}
.badge{display:inline-block;font:600 12px Inter,Arial,sans-serif;padding:2px 9px;border-radius:4px;white-space:nowrap}
.b-supported{background:var(--blue);color:#fff}
.b-restricted{background:var(--cream);color:var(--blue);border:1px solid var(--blue)}
.b-unsupported{background:var(--line);color:var(--ink)}
.b-defect{background:#fff;color:var(--ink);border:2px solid var(--orange)}.b-defect span{color:var(--orange)}
.b-incomplete{background:#fff;color:var(--ink);border:1px dashed var(--ink)}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}
thead th{background:var(--blue);color:#fff;text-align:left;font:600 13px Inter,Arial,sans-serif;padding:8px 10px}
td,tbody th{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;font-weight:400}
tbody tr:nth-child(even){background:#fbf7ee}
.small{font-size:13px}.tid{display:inline-block;font:600 11px Inter,Arial,sans-serif;background:var(--line);border-radius:3px;padding:1px 6px;margin:1px 2px 1px 0}
.defect{background:#fff;border:1px solid var(--line);border-left:4px solid var(--orange);border-radius:4px;padding:16px 20px;margin:14px 0}
.defect .did{color:var(--orange)}.defect p{margin:8px 0}.defect ol{margin:4px 0 8px;padding-left:22px}.defect li{margin:3px 0}
.defect .meta{font-size:13px}.defect .sev{font-weight:600}
.decision{background:var(--cream);border-radius:4px;padding:8px 12px}
figure{margin:12px 0 4px}.chart{width:100%;height:auto;max-width:760px;display:block}
.chart .axis{font:11px Inter,Arial,sans-serif;fill:var(--ink)}.chart .cat{font:12px Inter,Arial,sans-serif;fill:var(--ink)}.chart .val{font:600 11px Inter,Arial,sans-serif;fill:var(--ink)}
.chart path:focus,.chart path:hover{outline:none;stroke:var(--ink);stroke-width:1.5}
.legend{display:flex;gap:18px;font-size:13px;margin:0 0 4px}.legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
details.tableview{margin:8px 0 0}details summary{cursor:pointer;font:600 13px Inter,Arial,sans-serif;color:var(--blue)}details table{max-width:720px;margin-top:6px}
.chartnote{font-size:13px;margin:2px 0 6px;max-width:720px}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:#fff;font:600 12px Inter,Arial,sans-serif;padding:5px 9px;border-radius:4px;display:none;z-index:9}
.warn{border-left:4px solid var(--orange);background:#fff;padding:10px 14px;margin:10px 0;border-radius:4px;border:1px solid var(--line);border-left:4px solid var(--orange)}
footer{background:var(--blue);color:#fff;margin-top:56px;padding:18px 0;font-size:13px}footer b{font-family:Montserrat,Calibri,sans-serif}
code{background:var(--line);padding:1px 5px;border-radius:3px;font-size:13px;word-break:break-word}
ol.run li,ul.plain li{margin:5px 0}
</style></head><body>
<header class="top"><div class="wrap">
<div class="logo"><b>PROMANTIA</b><span>The Partner for Open Source Solutions</span></div>
<h1>${esc(m.title)}</h1>
<p class="sub">${esc(m.subtitle)}</p>
<div class="facts"><span><b>Ticket</b> ${esc(m.ticket)}</span><span><b>Branch</b> ${esc(m.branch)}</span><span><b>Site</b> ${esc(m.site)}</span><span><b>Results gathered</b> ${esc(m.results_gathered)}</span><span><b>Written for</b> ${esc(m.audience)}</span></div>
</div></header>
<main class="wrap">

<h2>The answer in brief</h2>
<div class="cols">
<div class="card ok"><h3>What is safe</h3>${ul(findings.summary.safe)}</div>
<div class="card alert"><h3>What is not, or needs a decision</h3>${ul(findings.summary.unsafe)}</div>
</div>
<div class="card" style="margin-top:16px"><h3>How to read the results</h3>
<p style="margin:0">Each row below is one arrangement of cashiers, profiles, accounts and shifts, with the outcome the ticket asks for: <b>Supported</b>, <b>Supported with restrictions</b>, <b>Unsupported, safely</b> (refused clearly, nothing lost) or <b>Defect</b>. The timings come from a single dev server and show shape, not production capacity. Section 5 lists what is not yet tested, so a gap is never read as a pass.</p></div>

<h2>1. Feasibility table</h2>
<div class="chips">${chips}</div>
<div class="tablewrap"><table><thead><tr><th>Arrangement</th><th>Mode</th><th>Outcome</th><th>What was observed</th><th>Tests</th></tr></thead><tbody>${feasRows}</tbody></table></div>

<h2>2. Defects</h2>
<p>Five defects, with the severity proposed here for you to confirm. Every one has steps that reproduce it; each is found by an automated test that fails while the behaviour exists.</p>
${defectCards}

<h2>3. Measurements</h2>
<p class="chartnote">All times are from the dev server described below. Every chart has a table view, and hovering a bar shows its value.</p>

<h3 style="margin-top:20px">Submit time as more cashiers sell at the same moment</h3>
<p class="chartnote">Each cashier opens a shift, then all create their draft and then all submit one sale together (headless sessions, one profile). Every sale was correct; the server handles about ${Math.round(burst[2].throughput ?? 2)} sales per second, so waiting grows with the crowd.</p>
${chart1}

<h3 style="margin-top:28px">Does a cashier selling online slow down while others catch up offline?</h3>
<p class="chartnote">Device A kept selling through the screen while devices B and C reconnected and drained backlogs, one of them with an invalid bill. A's times did not rise.</p>
${chart2}

<h3 style="margin-top:28px">Time for offline queues to settle after reconnecting</h3>
<p class="chartnote">Fault-free scenarios only. Devices drain in parallel, at roughly 6 to 8 seconds per bill on each device. Fault scenarios (flaps, 500s, session expiry) are excluded because they include deliberate delays.</p>
${chart3}

<h2>4. Other things worth knowing</h2>
<div class="cols">
<div class="card"><h3>Observations</h3>${ul(findings.observations)}</div>
<div class="card"><h3>Corrections made during testing</h3>${ul(findings.validity)}</div>
</div>

<h2>5. Not tested yet</h2>
<div class="card alert">${ul(findings.notTested)}</div>

<h2>6. How to run it</h2>
<div class="card"><ol class="run">${findings.howToRun.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>

<h2>Environment and method</h2>
<div class="card">${ul(m.environment)}
<p style="margin:10px 0 0">Races are made to overlap with explicit barriers and the overlap is measured, not assumed. Every sale is tracked in a manifest and compared against the server: invoice, stock movement and ledger balance. A fault is only counted if the test shows it really interrupted the request.</p></div>

<h2>Evidence consistency check</h2>
${warnings.length ? warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join("") : `<p>Every stated outcome is consistent with the latest completed evidence of each test (no test recorded a worse result than the one stated here).</p>`}
<p class="small">Generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC from ${latest.size} recorded test ids.</p>
</main>
<footer><div class="wrap"><b>PROMANTIA</b> | The Partner for Open Source Solutions</div></footer>
<div id="tip"></div>
<script>
(function(){var t=document.getElementById('tip');
function show(e){var el=e.target.closest('[data-tip]');if(!el){t.style.display='none';return}
t.textContent=el.getAttribute('data-tip');t.style.display='block';
var x=e.clientX!==undefined&&e.clientX?e.clientX:el.getBoundingClientRect().left;var y=e.clientY?e.clientY:el.getBoundingClientRect().top;
t.style.left=(x+12)+'px';t.style.top=(y-34)+'px'}
document.addEventListener('mousemove',show);document.addEventListener('focusin',show);
document.addEventListener('mouseleave',function(){t.style.display='none'});
document.addEventListener('focusout',function(){t.style.display='none'})})();
</script>
</body></html>`;

writeFileSync(path.join(outDir, "index.html"), html);
console.log(`report: ${path.join(outDir, "index.html")}`);
console.log(`measurements: ${path.join(outDir, "measurements.json")}`);
console.log(`${latest.size} test ids; ${warnings.length} consistency warning(s)`);
for (const w of warnings) console.log(`  - ${w}`);
