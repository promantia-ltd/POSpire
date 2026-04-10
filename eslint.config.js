import pluginVue from "eslint-plugin-vue";
import js from "@eslint/js";
import globals from "globals";

const frappeGlobals = {
	frappe: true,
	__: true,
	flt: true,
	cint: true,
	cstr: true,
	format_currency: true,
	format_number: true,
	get_number_format: true,
	get_currency_symbol: true,
	locals: true,
};

export default [
	js.configs.recommended,
	...pluginVue.configs["flat/recommended"],
	// Legacy Frappe doctype/API JS files
	{
		files: ["pospire/**/*.js"],
		languageOptions: {
			globals: {
				...globals.browser,
				...frappeGlobals,
				$: true,
			},
		},
		rules: {
			"no-unused-vars": "off",
		},
	},
	// Vue SPA
	{
		files: ["frontend/src/**/*.{js,vue}"],
		languageOptions: {
			globals: {
				...globals.browser,
				...frappeGlobals,
				onScan: true,
				vm: true,
			},
		},
		rules: {
			"no-console": "warn",
			"no-unused-vars": "off",
			"no-empty": "warn",
			"vue/multi-word-component-names": "off",
			"vue/no-unused-vars": "off",
			// Vuetify uses v-slot:item.column syntax which this rule misidentifies
			"vue/valid-v-slot": "off",
			// Vuetify components use v-html/v-text internally — safe in this context
			"vue/no-v-text-v-html-on-component": "off",
			// Side effects in computed are a code smell but widespread here
			"vue/no-side-effects-in-computed-properties": "warn",
			// Downgrade to warn — --quiet mode suppresses warnings, hooks still pass
			"vue/no-use-v-if-with-v-for": "warn",
			"vue/no-unused-components": "warn",
		},
	},
	{
		ignores: [
			"frontend/node_modules/**",
			"node_modules/**",
			"pospire/public/frontend/**",
			"pospire/public/js/**",
			// Third-party UMD library — uses module/define globals
			"pospire/pospire/page/posapp/onscan.js",
			"pospire/pospire/page/posapp/posapp.js",
			"dist/**",
			"**/*.min.js",
		],
	},
];
