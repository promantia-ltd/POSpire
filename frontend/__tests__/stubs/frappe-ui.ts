/**
 * Minimal frappe-ui stub for unit/integration tests.
 *
 * The real frappe-ui ships source with ESM-invalid relative imports (files
 * without extensions) that Node's ESM resolver rejects. Tests don't exercise
 * its real networking anyway — they either mock `call()` or exercise the
 * offline branches that never reach frappe-ui. This stub unblocks module
 * resolution so the imports succeed; any test that actually needs frappe-ui
 * behaviour must inject its own spy via `vi.mock`.
 */

export const call = async (_method: string, _args?: unknown): Promise<never> => {
	throw new Error(
		"frappe-ui stub: tests must mock `call` or exercise offline branches; " +
			"live network calls are not supported in the unit-test environment",
	);
};

export const frappeRequest = async (_opts: unknown): Promise<never> => {
	throw new Error("frappe-ui stub: frappeRequest is not available in tests");
};

// Vuetify/headless components occasionally re-exported from frappe-ui are
// never rendered in non-component tests; leave as `undefined` exports so the
// import resolves but any usage fails loudly if misused.
export const Button = undefined;
export const Dialog = undefined;
export const FormControl = undefined;
export const FeatherIcon = undefined;
export const LoadingIndicator = undefined;
export const LoadingText = undefined;
export default {};
