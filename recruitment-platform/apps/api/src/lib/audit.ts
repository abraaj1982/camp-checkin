// Re-exported so existing route imports ("../../lib/audit.js") don't
// change; the implementation now lives in @recruitment-platform/db so the
// worker can share it too (Phase 3 hardening — one audit-write path across
// both processes, not two copies of the same logic).
export { recordAudit } from "@recruitment-platform/db";
