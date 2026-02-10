export const amountRules = [
	(v) =>
		v === "" ||
		v === null ||
		v === undefined ||
		(!isNaN(v) && Number(v) >= 0) ||
		"Enter a non-negative number",
	(v) => (v !== null && v !== undefined ? String(v).length <= 12 : true) || "Input too long!",
];

export function isAmountValid(val) {
	if (val === "" || val === null || val === undefined) {
		return true;
	}
	if (isNaN(val)) {
		return false;
	}
	const num = Number(val);
	return num >= 0 && String(val).length <= 12;
}
