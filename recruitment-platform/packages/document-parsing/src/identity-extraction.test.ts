import { describe, expect, it } from "vitest";
import { extractEmail, extractPhone, normalizeEmail, normalizePhone, extractIdentity } from "./identity-extraction.js";

describe("identity-extraction (Phase 7 — deterministic, no AI)", () => {
  it("extracts the first email found in text", () => {
    expect(extractEmail("Contact: Jane.Doe@Example.com or jane2@other.com")).toBe("Jane.Doe@Example.com");
  });

  it("returns null when no email is present", () => {
    expect(extractEmail("No contact info here.")).toBeNull();
  });

  it("extracts the first phone-shaped substring found in text", () => {
    expect(extractPhone("Call +1 (555) 123-4567 or 555-000-1111")).toBe("+1 (555) 123-4567");
  });

  it("returns null when no phone is present", () => {
    expect(extractPhone("No contact info here.")).toBeNull();
  });

  it("normalizes email to lowercase + trim", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM  ")).toBe("jane.doe@example.com");
  });

  it("normalizes phone to digits only", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
  });

  it("does not collapse a leading country code — no country-code equivalence (accepted limitation)", () => {
    expect(normalizePhone("+1 555 123 4567")).not.toBe(normalizePhone("555 123 4567"));
  });

  it("extractIdentity combines extraction + normalization for both signals", () => {
    const result = extractIdentity("Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    expect(result).toEqual({
      rawEmail: "jane@example.com",
      rawPhone: "555-123-4567",
      normalizedEmail: "jane@example.com",
      normalizedPhone: "5551234567",
    });
  });

  it("extractIdentity returns nulls for both when neither signal is present", () => {
    expect(extractIdentity("No identifying information here.")).toEqual({
      rawEmail: null,
      rawPhone: null,
      normalizedEmail: null,
      normalizedPhone: null,
    });
  });
});
