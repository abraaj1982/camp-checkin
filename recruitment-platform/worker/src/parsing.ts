// Phase 7 — moved to @recruitment-platform/document-parsing so
// apps/api's Candidate Match Review resolution (which must re-derive
// identity from the same immutable stored document, without ever crossing
// a relative path into worker/src) can share this exact implementation.
// Re-exported here, at the same path, so worker/src/pipeline.ts's existing
// `import { parseDocument } from "./parsing.js"` needs no change at all.
export * from "@recruitment-platform/document-parsing/src/parsing.js";
