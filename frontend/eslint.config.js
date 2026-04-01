import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

export default [
	js.configs.recommended,
	...pluginVue.configs["flat/recommended"],
	{
		files: ["src/**/*.{vue,js}"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
				frappe: "readonly",
				__: "readonly",
				flt: "readonly",
				cint: "readonly",
				cstr: "readonly",
				format_currency: "readonly",
				format_number: "readonly",
				get_number_format: "readonly",
				get_currency_symbol: "readonly",
				onScan: "readonly",
			},
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
			"no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
			// Vuetify 3 uses v-slot modifier syntax (e.g. v-slot:activator.stop)
			"vue/valid-v-slot": ["error", { allowModifiers: true }],
			// Downgrade to warn — these are pre-existing patterns to fix separately
			"vue/no-use-v-if-with-v-for": "warn",
			"vue/no-unused-components": "warn",
			"vue/no-side-effects-in-computed-properties": "warn",
			"vue/no-v-text-v-html-on-component": "warn",
			"no-empty": ["warn", { allowEmptyCatch: true }],
			"no-unreachable": "warn",
			"no-mixed-spaces-and-tabs": "off",
		},
	},
	{
		ignores: ["node_modules/**", "dist/**"],
	},
];
