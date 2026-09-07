/** Whole-word match, case-insensitive — "Cashless" shouldn't resolve to "cash". */
function hasWord(name, word) {
	return new RegExp(`\\b${word}\\b`, "i").test(name);
}

/** Presentational only — maps a payment mode name to an mdi icon. */
export function paymentModeIcon(mode) {
	const name = mode || "";
	if (hasWord(name, "cash")) return "mdi-cash";
	if (hasWord(name, "upi") || hasWord(name, "qr")) return "mdi-qrcode";
	if (hasWord(name, "credit")) return "mdi-credit-card";
	if (hasWord(name, "debit")) return "mdi-credit-card-outline";
	if (hasWord(name, "gift")) return "mdi-gift-outline";
	if (hasWord(name, "wallet")) return "mdi-wallet-outline";
	if (hasWord(name, "bank")) return "mdi-bank";
	if (hasWord(name, "cheque") || hasWord(name, "check")) return "mdi-checkbook";
	return "mdi-cash-multiple";
}
