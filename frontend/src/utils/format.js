export default {
	data() {
		return {
			float_precision: 2,
			currency_precision: 2,
		};
	},
	methods: {
		flt(value, precision, number_format, rounding_method) {
			if (!precision && precision != 0) {
				precision = this.currency_precision || 2;
			}
			if (!rounding_method) {
				rounding_method = "Banker's Rounding (legacy)";
			}
			return flt(value, precision, number_format, rounding_method);
		},
		formatCurrency(value, precision) {
			const format = get_number_format(this.pos_profile?.currency);
			value = format_number(value, format, precision || this.currency_precision || 2);
			return value;
		},
		formatFloat(value, precision) {
			const format = get_number_format(this.pos_profile.currency);
			value = format_number(value, format, precision || this.float_precision || 2);
			return value;
		},
		setFormatedCurrency(el, field_name, precision, no_negative = false, $event) {
			let raw = 0;
			try {
				// Support both native input and string
				let inputValue = typeof $event === "object" ? $event.target.value : $event;
				inputValue = inputValue.replace(/[^\d.-]/g, ""); // remove commas, currency symbols
				let _value = parseFloat(inputValue);

				if (!isNaN(_value)) raw = _value;
				if (no_negative && raw < 0) raw = Math.abs(raw);

				// Save the raw number
				if (typeof el === "object") {
					el[field_name] = raw;
				} else {
					this[field_name] = raw;
				}

				return raw;
			} catch (e) {
				if (typeof el === "object") el[field_name] = 0;
				else this[field_name] = 0;
				return 0;
			}
		},

		setFormatedFloat(el, field_name, precision, no_negative = false, $event) {
			let raw = 0;
			try {
				// Support both native DOM Event (Vuetify 3 @change) and direct string/number value
				let inputValue = typeof $event === "object" ? $event.target.value : $event;
				inputValue = String(inputValue).replace(/[^\d.-]/g, ""); // strip commas, currency symbols
				let _value = parseFloat(inputValue);
				if (!isNaN(_value)) raw = _value;
				if (no_negative && raw < 0) raw = Math.abs(raw);
			} catch (e) {
				raw = 0;
			}
			if (typeof el === "object") {
				el[field_name] = raw;
			} else {
				this[field_name] = raw;
			}
			return raw;
		},
		currencySymbol(currency) {
			return get_currency_symbol(currency);
		},
		isNumber(value) {
			const pattern = /^-?(\d+|\d{1,3}(\.\d{3})*)(,\d+)?$/;
			return pattern.test(value) || "invalid number";
		},
	},
	mounted() {
		this.float_precision = window.sys_defaults?.float_precision || 2;
		this.currency_precision = window.sys_defaults?.currency_precision || 2;
	},
};
