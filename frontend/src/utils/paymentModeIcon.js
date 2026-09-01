/** Presentational only — maps a payment mode name to an mdi icon. */
export function paymentModeIcon(mode) {
	const name = (mode || "").toLowerCase();
	if (name.includes("cash")) return "mdi-cash";
	if (name.includes("upi") || name.includes("qr")) return "mdi-qrcode";
	if (name.includes("credit")) return "mdi-credit-card";
	if (name.includes("debit")) return "mdi-credit-card-outline";
	if (name.includes("gift")) return "mdi-gift-outline";
	if (name.includes("wallet")) return "mdi-wallet-outline";
	if (name.includes("bank")) return "mdi-bank";
	if (name.includes("cheque") || name.includes("check")) return "mdi-checkbook";
	return "mdi-cash-multiple";
}
