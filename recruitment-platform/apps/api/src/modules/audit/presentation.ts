import type { AuditLogRow } from "./project-scope.js";

/**
 * Audit Read API — presentation/privacy layer (approved design, revision 2).
 *
 * This is the ONLY place a raw `AuditLog` row is turned into an HTTP
 * response shape. It never reads `beforeJson`/`afterJson` (project-scope.ts
 * doesn't even SELECT them, except for the one jsonb containment test done
 * entirely in SQL) — every summary below is a fixed, server-authored
 * string, keyed off the action name alone, never built from payload
 * content. An action with no entry here fails closed: it still appears
 * (so HR isn't shown a silent gap in the timeline) but with a generic,
 * non-identifying summary — never the raw action string re-labeled as
 * prose, and never any payload field.
 */

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actorDisplayName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
}

const SUMMARY_BY_ACTION: Record<string, string> = {
  PROJECT_CREATED: "Project created.",
  PROJECT_EDITED: "Project details edited.",
  PROJECT_STATUS_CHANGED: "Project status changed.",
  PROJECT_MEMBER_ASSIGNED: "A team member was added to the project.",
  PROJECT_MEMBER_REMOVED: "A team member was removed from the project.",
  REQUIREMENT_CREATED: "Requirement created.",
  REQUIREMENT_EDITED: "Requirement edited.",
  REQUIREMENT_ARCHIVED: "Requirement archived.",
  REQUIREMENT_WEIGHT_CHANGED: "Requirement weight changed.",
  REQUIREMENT_VERSION_APPROVED: "Requirement version approved by HR.",
  REQUIREMENTS_AI_INTERPRETED: "AI interpretation run for project requirements.",
  REQUIREMENTS_AI_WEIGHTED: "AI weighting recommendation run for project requirements.",
  CANDIDATE_DOCUMENTS_UPLOADED: "Candidate CVs uploaded.",
  CANDIDATE_DOCUMENT_RETRY_REQUESTED: "Document processing retry requested.",
  STAGED_UPLOAD_RETRY_REQUESTED: "Staged upload retry requested.",
  CANDIDATE_DOCUMENT_NEEDS_OCR: "Document processing requires OCR.",
  CANDIDATE_DOCUMENT_AI_EXTRACTION_FAILED: "Document AI extraction failed.",
  CANDIDATE_DOCUMENT_PROCESSED: "Document processed.",
  CANDIDATE_EVIDENCE_ANALYSIS_AI_FAILED: "Candidate evidence analysis failed.",
  CANDIDATE_EVIDENCE_ANALYZED: "Candidate evidence analyzed.",
  CANDIDATE_CONSISTENCY_ANALYSIS_AI_FAILED: "Candidate consistency analysis failed.",
  CANDIDATE_CONSISTENCY_ANALYZED: "Candidate consistency analyzed.",
  CANDIDATE_MATCH_REVIEW_CREATED: "A candidate identity match needs review.",
  CANDIDATE_MATCH_REVIEW_RESOLVED: "A candidate identity match review was resolved.",
  CANDIDATE_PROMOTED_FROM_STAGED_UPLOAD: "A new candidate was added to the project.",
  HR_DECISION_RECORDED: "An HR decision was recorded for a candidate.",
  PROCESSING_RUN_STALE_WRITE_ABORTED: "A stale processing attempt was discarded.",
  // Product decision (approved): included in a project's feed only when
  // that project is a member of the event's own projectIdsCausingEligibility
  // array (tested in SQL, never read into this layer) — the summary below
  // is fixed and never interpolates any purge-payload field.
  CANDIDATE_PII_PURGED: "Candidate personal data was purged.",
};

const FALLBACK_SUMMARY = "An audited event occurred.";

export function presentAuditLogRow(row: AuditLogRow, actorNamesById: Map<string, string>): AuditLogEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    actorDisplayName: row.actorId ? (actorNamesById.get(row.actorId) ?? null) : null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    summary: SUMMARY_BY_ACTION[row.action] ?? FALLBACK_SUMMARY,
  };
}
