/**
 * Deterministic V1 evidence redaction (architecture doc, Section: Evidence
 * Redaction Layer). This is a view-time transform only — it never mutates
 * stored Evidence rows, and it never changes factual meaning, only strips or
 * tokenizes identifying spans. The AI-based rewrite pass for subtler leakage
 * is deferred (Decision 9 in the architecture doc) and not implemented here.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

export function redactDirectIdentifiers(text: string): string {
  return text.replace(EMAIL_RE, "[redacted email]").replace(PHONE_RE, "[redacted phone]");
}

/**
 * Replaces known employer names with stable per-candidate tokens (Company A,
 * Company B, ...) so a unique employer name can't indirectly identify the
 * candidate in Blind Mode. `employerOrder` should be built once per
 * candidate (e.g. from CandidateExperience rows) so the same employer always
 * maps to the same token within one blind view.
 */
export function tokenizeEmployers(text: string, employerOrder: string[]): string {
  let result = text;
  employerOrder.forEach((employer, index) => {
    if (!employer) return;
    const token = `Company ${String.fromCharCode(65 + (index % 26))}`;
    const escaped = employer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), token);
  });
  return result;
}

export function redactEvidenceForBlindMode(text: string, employerOrder: string[]): string {
  return tokenizeEmployers(redactDirectIdentifiers(text), employerOrder);
}

/**
 * Fields stripped from any payload sent to an AI provider or rendered to the
 * frontend while Blind Screening is active (architecture doc, Section 20 /
 * AI Provider Abstraction). Kept as a single source of truth so the API
 * layer and the AI Gateway agree on what "blind" means.
 */
export const BLIND_SCREENING_STRIPPED_FIELDS = [
  "fullName",
  "photoUrl",
  "dateOfBirth",
  "gender",
  "nationality",
  "maritalStatus",
  "email",
  "phone",
] as const;

export function stripBlindFields<T extends Record<string, unknown>>(input: T): Partial<T> {
  const clone: Partial<T> = { ...input };
  for (const field of BLIND_SCREENING_STRIPPED_FIELDS) {
    delete (clone as Record<string, unknown>)[field];
  }
  return clone;
}
