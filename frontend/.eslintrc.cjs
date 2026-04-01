module.exports = {
	root: true,
	env: {
		browser: true,
		es2022: true,
		node: true,
	},
	extends: [
		"eslint:recommended",
		"plugin:vue/vue3-recommended",
	],
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module",
	},
	rules: {
		"no-console": ["warn"],
		// Formatting is handled by Prettier
		"vue/html-indent": "off",
		"vue/max-attributes-per-line": "off",
		"vue/html-self-closing": "off",
		"vue/singleline-html-element-content-newline": "off",
		// Common patterns in this project
		"vue/multi-word-component-names": "off",
		"vue/no-v-html": "off",
		"no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
		// Vuetify 3 uses v-slot modifier syntax (e.g. v-slot:activator.stop)
		"vue/valid-v-slot": ["error", { "allowModifiers": true }],
		// Downgrade to warn — these are pre-existing patterns to fix separately
		"vue/no-use-v-if-with-v-for": "warn",
		"vue/no-unused-components": "warn",
		"vue/no-side-effects-in-computed-properties": "warn",
		"vue/no-v-text-v-html-on-component": "warn",
		"no-empty": ["warn", { "allowEmptyCatch": true }],
		"no-unreachable": "warn",
		// Formatting handled by Prettier
		"no-mixed-spaces-and-tabs": "off",
	},
	globals: {
		frappe: "readonly",
		__: "readonly",
		// Frappe utility globals available in Vue SPA via frappe-ui boot
		flt: "readonly",
		cint: "readonly",
		cstr: "readonly",
		format_currency: "readonly",
		format_number: "readonly",
		get_number_format: "readonly",
		// Set on window by main.js from ./utils/numberFormat
		get_currency_symbol: "readonly",
		// onscan.js attaches to window
		onScan: "readonly",
	},
};
