import { describe, expect, it } from "vitest";
import { redactEvidenceForBlindMode, stripBlindFields } from "./redaction.js";

describe("redactEvidenceForBlindMode", () => {
  it("strips emails and phone numbers without altering the rest of the text", () => {
    const text = "Contact jane.doe@example.com or +1 (555) 123-4567 for a reference.";
    const redacted = redactEvidenceForBlindMode(text, []);
    expect(redacted).not.toContain("jane.doe@example.com");
    expect(redacted).not.toContain("555");
    expect(redacted).toContain("for a reference.");
  });

  it("tokenizes employer names consistently", () => {
    const text = "Led the HR team at Acme Corp before moving to Acme Corp's regional office.";
    const redacted = redactEvidenceForBlindMode(text, ["Acme Corp"]);
    expect(redacted).not.toContain("Acme Corp");
    expect(redacted).toContain("Company A");
  });

  it("preserves factual content it does not redact", () => {
    const text = "Managed a team of 12 recruiters across three regions.";
    expect(redactEvidenceForBlindMode(text, [])).toBe(text);
  });
});

describe("stripBlindFields", () => {
  it("removes every configured identifier field", () => {
    const stripped = stripBlindFields({
      fullName: "Jane Doe",
      email: "jane@example.com",
      skillName: "Payroll",
    });

    expect(stripped).not.toHaveProperty("fullName");
    expect(stripped).not.toHaveProperty("email");
    expect(stripped.skillName).toBe("Payroll");
  });
});
