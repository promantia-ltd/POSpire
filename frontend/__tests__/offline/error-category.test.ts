import { expect, it } from "vitest";

import { errorCodeToCategory } from "@/offline/sync";

it("maps number_conflict to its own category", () => {
	expect(errorCodeToCategory("number_conflict", "validation_error")).toBe("number_conflict");
});
