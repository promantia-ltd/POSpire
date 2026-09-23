/**
 * Decide which ApprovalDialog screen to show for a required action.
 *
 * Frappe Check values may arrive as 1/0, true/false, or "1"/"0". Only the
 * explicit on-values count as enabled — a string "0" must not be treated as
 * truthy.
 */

export type ApprovalDialogStep = "choose" | "pin" | "waiting" | "misconfigured";

export function isApprovalFlagOn(value: unknown): boolean {
	return value === true || value === 1 || value === "1";
}

export function resolveInitialApprovalStep(
	actionConfig: { pin_approval?: unknown; remote_approval?: unknown } | null | undefined,
	remoteApprovalEnabled: boolean,
): ApprovalDialogStep {
	const pin = isApprovalFlagOn(actionConfig?.pin_approval);
	const remote = isApprovalFlagOn(actionConfig?.remote_approval) && !!remoteApprovalEnabled;
	if (pin && remote) return "choose";
	if (pin) return "pin";
	if (remote) return "waiting";
	return "misconfigured";
}
