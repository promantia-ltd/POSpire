/**
 * Translation function — replaces window.__() from Frappe desk.
 *
 * Loads translations from Frappe's translation API on first call,
 * then looks up strings from a module-level dictionary.
 */

let translations = {};
let loaded = false;

export async function loadTranslations() {
	try {
		const res = await fetch("/api/method/frappe.client.get_translations", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		if (res.ok) {
			const data = await res.json();
			translations = data.message || {};
			loaded = true;
		}
	} catch {
		// Translations unavailable — strings pass through untranslated
	}
}

export function __(msg, replace, context) {
	if (!msg) return msg;

	let translated = translations[msg] || msg;

	if (replace && Array.isArray(replace)) {
		replace.forEach((val, i) => {
			translated = translated.replace(`{${i}}`, val);
		});
	}

	return translated;
}
