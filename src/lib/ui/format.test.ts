import { describe, expect, it } from "vitest";
import { CAN_REVALIDATE, formatRupees, humanField, resolutionFor } from "./format";

describe("formatRupees (display only, integer paise)", () => {
  it.each([[1_000_000, "₹10,000"], [50_000, "₹500"], [49_950, "₹499.50"], [5, "₹0.05"], [0, "₹0"], [123_456_700, "₹12,34,567"]])(
    "%i paise -> %s", (p, s) => expect(formatRupees(p)).toBe(s));
});

describe("resolutionFor", () => {
  it("maps backend statuses to the three UI states", () => {
    expect(resolutionFor("READY_FOR_PAYMENT_APPROVAL")).toBe("RESOLVED");
    expect(resolutionFor("NO_DISCREPANCY")).toBe("RESOLVED");
    expect(resolutionFor("DISCREPANCY_FOUND")).toBe("NEEDS_CORRECTION");
    expect(resolutionFor("AWAITING_SUPPLIER")).toBe("NEEDS_CORRECTION");
    expect(resolutionFor("NEEDS_REVIEW")).toBe("AWAITING_REVIEW");
    expect(resolutionFor("ERROR")).toBe("AWAITING_REVIEW");
  });
  it("never offers revalidation for a resolved case", () => {
    expect(CAN_REVALIDATE).not.toContain("READY_FOR_PAYMENT_APPROVAL");
    expect(CAN_REVALIDATE).toContain("DISCREPANCY_FOUND");
  });
});

describe("humanField", () => {
  it("humanises item paths", () => {
    expect(humanField("items[0].quantity")).toBe("Line 1 · quantity");
    expect(humanField("items[2].unitPricePaise")).toBe("Line 3 · unitPrice");
    expect(humanField("poNumber")).toBe("poNumber");
  });
});
