import js from "@eslint/js";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

export default [
	js.configs.recommended,
	...pluginVue.configs["flat/recommended"],
	{
		files: ["src/**/*.{vue,js,ts}"],
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
			// XSS surface — every v-html site that took cashier-entered or
			// stored content was migrated to text interpolation (or
			// `white-space: pre-line` for newline-preserving descriptions).
			// Keeping this as `error` enforces the boundary at PR time so a
			// future addition can't sneak v-html back in unreviewed.
			"vue/no-v-html": "error",
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
			// -----------------------------------------------------------------
			// P-2 single API boundary — every network call goes through
			// @/utils/call. Direct frappe-ui imports are banned. See
			// docs/offline/09-api-boundary.md §5.
			// -----------------------------------------------------------------
			"no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "frappe-ui",
							message:
								"Network IO must go through @/utils/call. Import helpers from frappe-ui only inside src/utils/call.ts, src/utils/call-registry.ts, or src/main.js.",
						},
					],
					patterns: [
						{
							group: ["frappe-ui/*"],
							message:
								"Network IO must go through @/utils/call. Import helpers from frappe-ui only inside src/utils/call.ts, src/utils/call-registry.ts, or src/main.js.",
						},
					],
				},
			],
		},
	},
	{
		// Wrapper implementation and the main-bundle bootstrap are the ONLY
		// files permitted to import from frappe-ui directly.
		files: [
			"src/utils/call.ts",
			"src/utils/call.js",
			"src/utils/call-registry.ts",
			"src/offline/connectivity.ts",
			"src/main.js",
		],
		rules: {
			"no-restricted-imports": "off",
		},
	},
	{
		ignores: ["node_modules/**", "dist/**"],
	},
];
