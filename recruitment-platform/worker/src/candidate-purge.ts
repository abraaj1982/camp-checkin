// Phase 8 — moved to @recruitment-platform/candidate-retention so
// apps/api's manual purge endpoint (which must call the exact same
// eligibility/execution logic as this worker's scheduled scan) can share
// one implementation without crossing an app boundary — same pattern
// Phase 7 already established for @recruitment-platform/document-parsing.
export * from "@recruitment-platform/candidate-retention/src/candidate-purge.js";
