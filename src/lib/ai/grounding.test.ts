import { describe, expect, it } from "vitest";
import { isGrounded } from "./grounding";

const facts = JSON.stringify({ invoice: "INV-1001", ordered: 100, acceptedPerGrn: 80, underReviewBeforeGst: "₹10,000.00" });

describe("isGrounded", () => {
  it("accepts prose using only given numbers and citing a document", () =>
    expect(isGrounded("INV-1001 bills 100 but 80 were accepted; ₹10,000 is under review.", facts, ["INV-1001"])).toBe(true));
  it("rejects an invented number", () =>
    expect(isGrounded("INV-1001: supplier admitted shipping 75 cartons.", facts, ["INV-1001"])).toBe(false));
  it("rejects prose citing no document", () => expect(isGrounded("100 ordered, 80 accepted.", facts, ["INV-1001"])).toBe(false));
  it("rejects empty text", () => expect(isGrounded("  ", facts, ["INV-1001"])).toBe(false));
});
