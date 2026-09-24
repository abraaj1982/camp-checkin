/**
 * Phase 7 — Candidate Deduplication / Reuse across Projects.
 *
 * Deterministic, non-AI identity extraction from a parsed document's plain
 * text. This module has NO dependency on @recruitment-platform/ai-gateway's
 * AiGateway/ClaudeProvider — it runs before, and independently of, any AI
 * call, and nothing it produces is ever passed into one (Phase 7A Decision:
 * "Do NOT use AI/Claude for identity extraction," "Do NOT send email,
 * phone, or candidate identity information to the AI Gateway").
 *
 * The two patterns below intentionally mirror
 * packages/ai-gateway/src/redaction.ts's EMAIL_RE/PHONE_RE (used there to
 * REDACT; used here, non-global, to EXTRACT the first match) — duplicated
 * rather than imported so this module has zero dependency on the blind-
 * screening redaction module, which stays completely untouched by Phase 7.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;

/** First email substring found in the text, or null. Deterministic: no fuzzy/AI judgment. */
export function extractEmail(text: string): string | null {
  return text.match(EMAIL_RE)?.[0] ?? null;
}

/** First phone-shaped substring found in the text, or null. */
export function extractPhone(text: string): string | null {
  return text.match(PHONE_RE)?.[0] ?? null;
}

/** Exact, deterministic normalization: lowercase + trim. No sub-address/plus-addressing collapsing. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Exact, deterministic normalization: digits only. No country-code equivalence. */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

export interface ExtractedIdentity {
  rawEmail: string | null;
  rawPhone: string | null;
  normalizedEmail: string | null;
  normalizedPhone: string | null;
}

/** Runs extraction + normalization together — the single entry point every caller should use. */
export function extractIdentity(text: string): ExtractedIdentity {
  const rawEmail = extractEmail(text);
  const rawPhone = extractPhone(text);
  return {
    rawEmail,
    rawPhone,
    normalizedEmail: rawEmail ? normalizeEmail(rawEmail) : null,
    normalizedPhone: rawPhone ? normalizePhone(rawPhone) : null,
  };
}
