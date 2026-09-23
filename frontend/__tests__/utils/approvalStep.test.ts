import { describe, expect, it } from "vitest";
import { isApprovalFlagOn, resolveInitialApprovalStep } from "@/utils/approvalStep";

describe("isApprovalFlagOn", () => {
	it("treats Frappe Check on-values as enabled", () => {
		expect(isApprovalFlagOn(1)).toBe(true);
		expect(isApprovalFlagOn("1")).toBe(true);
		expect(isApprovalFlagOn(true)).toBe(true);
	});

	it("treats Frappe Check off-values as disabled, including string zero", () => {
		expect(isApprovalFlagOn(0)).toBe(false);
		expect(isApprovalFlagOn("0")).toBe(false);
		expect(isApprovalFlagOn(false)).toBe(false);
		expect(isApprovalFlagOn(null)).toBe(false);
		expect(isApprovalFlagOn(undefined)).toBe(false);
		expect(isApprovalFlagOn("")).toBe(false);
	});
});

describe("resolveInitialApprovalStep", () => {
	it("returns choose when PIN and remote are both available", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: 1, remote_approval: 1 }, true),
		).toBe("choose");
	});

	it("returns pin when only PIN is enabled", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: 1, remote_approval: 0 }, true),
		).toBe("pin");
	});

	it("returns pin when remote is on the action but the profile flag is off", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: 1, remote_approval: 1 }, false),
		).toBe("pin");
	});

	it("returns waiting when only remote is available", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: 0, remote_approval: 1 }, true),
		).toBe("waiting");
	});

	it("returns misconfigured when neither PIN nor remote is available", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: 0, remote_approval: 0 }, true),
		).toBe("misconfigured");
		expect(
			resolveInitialApprovalStep({ pin_approval: 0, remote_approval: 1 }, false),
		).toBe("misconfigured");
		expect(resolveInitialApprovalStep({}, true)).toBe("misconfigured");
	});

	it("does not treat a string zero PIN flag as enabled", () => {
		expect(
			resolveInitialApprovalStep({ pin_approval: "0", remote_approval: 1 }, true),
		).toBe("waiting");
	});
});
