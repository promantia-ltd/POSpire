export function formatCurrency(value) {
	const number = Number(value) || 0;
	return `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function formatNumber(value) {
	const number = Number(value) || 0;
	return number.toLocaleString("en-IN", {
		maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
	});
}

export function formatPoints(value) {
	const number = Number(value) || 0;
	return `${number.toLocaleString("en-IN", { maximumFractionDigits: 0 })} ${__("Points")}`;
}

export function formatPercentage(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "0%";
	return `${number.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

function formatCompactNumber(value) {
	return Number(value).toLocaleString("en-IN", {
		maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
	});
}

export function formatCompactCurrency(value) {
	const number = Number(value) || 0;
	const absNumber = Math.abs(number);
	if (absNumber >= 10000000) return `₹${formatCompactNumber(number / 10000000)}Cr`;
	if (absNumber >= 100000) return `₹${formatCompactNumber(number / 100000)}L`;
	if (absNumber >= 1000) return `₹${formatCompactNumber(number / 1000)}K`;
	return `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function formatHourLabel(value) {
	const hour = Number(String(value).split(":")[0]);
	if (!Number.isFinite(hour)) return value;
	const period = hour >= 12 ? "PM" : "AM";
	const hour12 = hour % 12 || 12;
	return `${String(hour12).padStart(2, "0")} ${period}`;
}

export function niceTickStep(maxValue, ticks) {
	if (!Number.isFinite(maxValue) || maxValue <= 0) return 1;
	const roughStep = maxValue / Math.max(ticks - 1, 1);
	const magnitude = 10 ** Math.floor(Math.log10(roughStep));
	const normalized = roughStep / magnitude;
	let niceNormalized = 10;
	if (normalized <= 1) {
		niceNormalized = 1;
	} else if (normalized <= 2) {
		niceNormalized = 2;
	} else if (normalized <= 5) {
		niceNormalized = 5;
	}
	return niceNormalized * magnitude;
}
