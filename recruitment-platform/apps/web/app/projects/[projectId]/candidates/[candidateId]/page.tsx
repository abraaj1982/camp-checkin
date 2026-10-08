"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../../lib/api";
import { StatusBadge } from "../../../../components/StatusBadge";
import { EvidenceCard as SharedEvidenceCard } from "../../../../components/EvidenceCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ProcessingState } from "../../../../components/ProcessingState";
import { FailedState } from "../../../../components/FailedState";
import { Card } from "../../../../components/Card";
import { MetricCard } from "../../../../components/MetricCard";
import { Disclaimer, DECISION_INDEPENDENCE_TEXT } from "../../../../components/Disclaimer";
import { colors, radii, spacing, typeScale } from "../../../../design-tokens";

/**
 * Phase 5B — read-only Evidence Viewer / Career Consistency Viewer.
 *
 * Security note: the server (Phase 5A) is the ONLY redaction/blind-screening
 * boundary. This page renders exactly the fields the API sends — it never
 * hides a field the API already returned, because the API never returns
 * an identifying field to begin with. The types below are deliberately
 * narrow (only the fields these two endpoints actually send) rather than a
 * reused, broader "Candidate" type — a defensive allow-list at the type
 * boundary, not a second redaction layer.
 */

type AssessmentStatus = "STRONG_EVIDENCE" | "REVIEW_REQUIRED" | "MANDATORY_GAP" | "INSUFFICIENT_EVIDENCE";
type EvidenceRole = "SUPPORTING" | "CONSIDERED_REJECTED";

interface EvidenceItem {
  role: EvidenceRole;
  rationale: string | null;
  evidenceStrength: string;
  confidence: string;
  evidenceType: string;
  sourcePage: number | null;
  evidenceText: string | null;
  source: string | null;
}

interface AssessmentItem {
  id: string;
  status: AssessmentStatus;
  requirement: {
    id: string;
    description: string;
    mandatory: boolean;
    category: string;
    hrApprovedWeight: string | null;
  };
  requirementVersion: { id: string; versionNumber: number; evidenceCriteriaSnapshot: unknown } | null;
  evidence: EvidenceItem[];
  // Phase 12 (C3) — profile/publication-authority indicator only (never an
  // evidence-quality signal): whether this Assessment's ProcessingRun is
  // the candidate's current Phase 11 authoritative one.
  isAuthoritative: boolean;
}

interface AssessmentsResponse {
  candidate: { id: string; anonymizedLabel: string };
  assessments: AssessmentItem[];
}

interface ConsistencyFinding {
  findingType: string;
  severity: string;
  description: string;
  sourcePage: number | null;
  evidenceText: string | null;
  confidence: string;
  source: string | null;
  isAuthoritative: boolean;
}

interface ConsistencyResponse {
  candidate: { id: string; anonymizedLabel: string };
  findings: ConsistencyFinding[];
}

// Deliberately narrow slice of the /projects/:id/candidates response — this
// page reads ONLY anonymizedLabel and each document's status +
// hasCurrentRun. The type below declares nothing else, so nothing else can
// be accidentally rendered from it.
//
// hasCurrentRun (Phase 5C hardening: apps/api/src/modules/candidates/routes.ts)
// is a boolean derived server-side from currentProcessingRunId !== null —
// the run id itself is never exposed. It exists purely so this page can
// tell "a current run exists but produced zero results" apart from "no run
// has ever completed," without needing the internal run id at all.
type DocumentStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED_RETRY" | "FAILED_NEEDS_OCR";
interface CandidateStatusLink {
  candidateId: string;
  anonymizedLabel: string;
  documents: { status: DocumentStatus; hasCurrentRun: boolean }[];
}

type DecisionType = "SHORTLIST" | "HOLD" | "REJECT" | "INTERVIEW";
const DECISION_OPTIONS: DecisionType[] = ["SHORTLIST", "INTERVIEW", "HOLD", "REJECT"];

interface DecisionOverride {
  assessmentId: string;
  overridden: boolean;
  hrNote: string | null;
  // Phase 12 (C3) — durable provenance: null means this decision predates
  // this field (genuinely unknown), never inferred from current state.
  wasAuthoritativeAtDecision: boolean | null;
}

interface Decision {
  id: string;
  decision: DecisionType;
  notes: string | null;
  decidedAt: string;
  decidedByName: string;
  override: DecisionOverride | null;
}

interface DecisionsResponse {
  decisions: Decision[];
}

function sourceLabel(source: string | null, sourcePage: number | null): string {
  if (!source) return "No source";
  return sourcePage !== null ? `${source}, page ${sourcePage}` : source;
}

function AssessmentCard({ assessment }: { assessment: AssessmentItem }) {
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const supporting = assessment.evidence.filter((e) => e.role === "SUPPORTING");
  const rejected = assessment.evidence.filter((e) => e.role === "CONSIDERED_REJECTED");
  const criteria = Array.isArray(assessment.requirementVersion?.evidenceCriteriaSnapshot)
    ? (assessment.requirementVersion!.evidenceCriteriaSnapshot as unknown[])
    : null;

  return (
    <section style={{ border: `1px solid ${colors.border}`, borderRadius: radii.md, padding: spacing.lg, marginBottom: spacing.lg }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.md }}>
        <div>
          <h3 style={{ margin: 0, ...typeScale.cardTitle }}>{assessment.requirement.description}</h3>
          <p style={{ margin: "4px 0", ...typeScale.meta }}>
            {assessment.requirement.mandatory ? "Mandatory" : "Optional"} · {assessment.requirement.category}
            {assessment.requirement.hrApprovedWeight !== null && ` · Weight: ${assessment.requirement.hrApprovedWeight}`}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <StatusBadge status={assessment.status} />
          <p style={{ margin: "4px 0 0", fontSize: 11, color: assessment.isAuthoritative ? colors.success700 : colors.caution700 }}>
            {/* Filled dot = current/authoritative, hollow dot = other — never color alone (accessibility). */}
            <span aria-hidden="true">{assessment.isAuthoritative ? "●" : "○"}</span>{" "}
            {assessment.isAuthoritative ? "Current profile" : "Other current document"}
          </p>
        </div>
      </div>

      {criteria && criteria.length > 0 && (
        <div style={{ marginTop: spacing.sm }}>
          <button onClick={() => setCriteriaOpen((v) => !v)} style={{ fontSize: 13 }}>
            {criteriaOpen ? "Hide" : "Show"} Evidence Criteria
          </button>
          {criteriaOpen && (
            <ul style={{ marginTop: spacing.sm }}>
              {criteria.map((c, i) => (
                <li key={i} style={typeScale.meta}>
                  {String(c)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ marginTop: spacing.md }}>
        <h4 style={{ margin: "0 0 4px" }}>Supporting Evidence</h4>
        {supporting.length === 0 ? (
          <EmptyState>None.</EmptyState>
        ) : (
          supporting.map((e, i) => <SharedEvidenceCard key={i} item={e} />)
        )}
      </div>
      <div style={{ marginTop: spacing.md }}>
        <h4 style={{ margin: "0 0 4px" }}>Considered Rejected Evidence</h4>
        {rejected.length === 0 ? (
          <EmptyState>None.</EmptyState>
        ) : (
          rejected.map((e, i) => <SharedEvidenceCard key={i} item={e} />)
        )}
      </div>
    </section>
  );
}

/**
 * Phase 6 — HR Decision UI. A decision is a human action taken in response
 * to the evidence already shown above; this panel never computes, ranks, or
 * suggests one. The override picker offers ONLY the candidate's current-run
 * assessments (Decision 3) — the same list already rendered above, so no
 * separate/looser fetch is introduced. Decision notes are HR's own
 * free text about their own reasoning, not AI-extracted candidate text, so
 * they are intentionally not passed through blind redaction (Decision 8).
 */
function DecisionsPanel({
  projectId,
  candidateId,
  currentAssessments,
}: {
  projectId: string;
  candidateId: string;
  currentAssessments: AssessmentItem[];
}) {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [decisionType, setDecisionType] = useState<DecisionType>("SHORTLIST");
  const [notes, setNotes] = useState("");
  const [assessmentId, setAssessmentId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<DecisionsResponse>(`/projects/${projectId}/candidates/${candidateId}/decisions`);
      setDecisions(res.decisions);
      setError(null);
    } catch {
      setError("Could not load decision history.");
    } finally {
      setLoading(false);
    }
  }, [projectId, candidateId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/candidates/${candidateId}/decisions`, {
        method: "POST",
        body: JSON.stringify({
          decision: decisionType,
          notes: notes.trim() || undefined,
          assessmentId: assessmentId || undefined,
        }),
      });
      setNotes("");
      setAssessmentId("");
      await load();
    } catch {
      setError("Could not record decision.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section style={{ marginTop: spacing.xl }}>
      <h2 style={typeScale.sectionTitle}>Decisions</h2>
      <Disclaimer text={DECISION_INDEPENDENCE_TEXT} />

      <Card style={{ marginBottom: spacing.lg }}>
      <form onSubmit={handleSubmit}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label>
            <div style={{ fontSize: 13, marginBottom: 4 }}>Decision</div>
            <select value={decisionType} onChange={(e) => setDecisionType(e.target.value as DecisionType)}>
              {DECISION_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          {currentAssessments.length > 0 && (
            <label>
              <div style={{ fontSize: 13, marginBottom: 4 }}>Override assessment (optional)</div>
              <select value={assessmentId} onChange={(e) => setAssessmentId(e.target.value)}>
                <option value="">None</option>
                {currentAssessments.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.requirement.description} — {a.status.replaceAll("_", " ")}
                    {a.isAuthoritative ? "" : " (other current document)"}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button type="submit" disabled={submitting}>
            {submitting ? "Recording…" : "Record Decision"}
          </button>
        </div>
        <label style={{ display: "block", marginTop: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>Notes (optional)</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ width: "100%" }}
            placeholder="Why this decision?"
          />
        </label>
      </form>
      </Card>

      {error && <p style={{ color: colors.danger700 }}>{error}</p>}

      {loading ? (
        <p>Loading decisions…</p>
      ) : decisions.length === 0 ? (
        <EmptyState>No decisions recorded yet.</EmptyState>
      ) : (
        decisions.map((d) => (
          <Card key={d.id} style={{ marginBottom: spacing.sm, padding: spacing.md }}>
            <p style={{ margin: 0, fontWeight: 600 }}>
              {d.decision} <span style={{ fontWeight: 400, fontSize: 12, color: colors.ink400 }}>by {d.decidedByName}</span>
            </p>
            {d.notes && <p style={{ margin: "8px 0" }}>{d.notes}</p>}
            {d.override && (
              <p style={{ margin: 0, fontSize: 12, color: colors.ink400 }}>
                {d.override.overridden ? "Overrides an AI assessment gap." : "Agrees with the AI assessment."}
                {d.override.wasAuthoritativeAtDecision === false && " · Cited a non-authoritative document."}
                {d.override.wasAuthoritativeAtDecision === null && " · Authority not recorded (predates this feature)."}
              </p>
            )}
            <p style={{ margin: "4px 0 0", fontSize: 11, color: colors.ink400 }}>{new Date(d.decidedAt).toLocaleString()}</p>
          </Card>
        ))
      )}
    </section>
  );
}

function FindingCard({ finding }: { finding: ConsistencyFinding }) {
  return (
    <Card style={{ marginBottom: spacing.sm, padding: spacing.md }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {finding.findingType.replaceAll("_", " ")} — <span style={{ fontWeight: 400 }}>{finding.severity.replaceAll("_", " ")}</span>
        <span
          style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: finding.isAuthoritative ? colors.success700 : colors.caution700 }}
        >
          {finding.isAuthoritative ? "Current profile" : "Other current document"}
        </span>
      </p>
      <p style={{ margin: "8px 0" }}>{finding.description}</p>
      {finding.evidenceText && <p style={{ margin: "8px 0", color: colors.ink600 }}>&ldquo;{finding.evidenceText}&rdquo;</p>}
      <p style={{ margin: 0, fontSize: 12, color: colors.ink400 }}>
        Confidence: {finding.confidence} · {sourceLabel(finding.source, finding.sourcePage)}
      </p>
    </Card>
  );
}

export default function CandidateDetailPage() {
  const { projectId, candidateId } = useParams<{ projectId: string; candidateId: string }>();
  const [assessments, setAssessments] = useState<AssessmentsResponse | null>(null);
  const [findings, setFindings] = useState<ConsistencyResponse | null>(null);
  const [statusLink, setStatusLink] = useState<CandidateStatusLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const [assessmentsRes, findingsRes, links] = await Promise.all([
        apiFetch<AssessmentsResponse>(`/projects/${projectId}/candidates/${candidateId}/assessments`),
        apiFetch<ConsistencyResponse>(`/projects/${projectId}/candidates/${candidateId}/consistency-findings`),
        apiFetch<CandidateStatusLink[]>(`/projects/${projectId}/candidates`),
      ]);
      setAssessments(assessmentsRes);
      setFindings(findingsRes);
      setStatusLink(links.find((l) => l.candidateId === candidateId) ?? null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true);
      } else {
        setError("Could not load candidate results.");
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, candidateId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <main style={{ maxWidth: 900 }}>
        <p>Loading…</p>
      </main>
    );
  }

  if (notFound) {
    return (
      <main style={{ maxWidth: 900 }}>
        <p><Link href={`/projects/${projectId}/candidates`}>← Back to candidates</Link></p>
        <p>Candidate not found in this project.</p>
      </main>
    );
  }

  if (error || !assessments || !findings) {
    return (
      <main style={{ maxWidth: 900 }}>
        <p><Link href={`/projects/${projectId}/candidates`}>← Back to candidates</Link></p>
        <p style={{ color: colors.danger700 }}>{error ?? "Could not load candidate results."}</p>
      </main>
    );
  }

  const documents = statusLink?.documents ?? [];
  const isProcessing = documents.some((d) => d.status === "QUEUED" || d.status === "PROCESSING");
  const hasResults = assessments.assessments.length > 0 || findings.findings.length > 0;
  // A current run that legitimately produced zero assessments/findings
  // (hasResults === false) must never be mistaken for "no run at all" just
  // because some OTHER document for this candidate happens to be
  // FAILED_RETRY — hasCurrentRun (a boolean derived server-side from
  // currentProcessingRunId, Phase 5C hardening) is the minimal, non-
  // identifying signal that distinguishes them, so the failed state is
  // shown only when no document has a current run.
  const hasCurrentRun = documents.some((d) => d.hasCurrentRun);
  const isFailed =
    !hasResults && !isProcessing && !hasCurrentRun && documents.some((d) => d.status === "FAILED_RETRY");

  // Same candidate-level rollup convention as the Candidates workspace table
  // (UI Batch 4) — a synthetic, client-computed key distinct from any raw
  // document/assessment status, used only for this header badge.
  const overallStatus = isProcessing ? "PROCESSING" : hasResults || hasCurrentRun ? "READY" : "FAILED";

  const completedCount = documents.filter((d) => d.status === "COMPLETED").length;
  const processingCount = documents.filter((d) => d.status === "QUEUED" || d.status === "PROCESSING").length;

  const mandatoryGapCount = assessments.assessments.filter(
    (a) => a.requirement.mandatory && a.status === "MANDATORY_GAP",
  ).length;

  return (
    <main style={{ maxWidth: 900 }}>
      <p><Link href={`/projects/${projectId}/candidates`} style={{ color: colors.brand700 }}>← Back to candidates</Link></p>
      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
        <h1 style={{ ...typeScale.pageTitle, margin: 0 }}>{assessments.candidate.anonymizedLabel}</h1>
        <StatusBadge status={overallStatus} />
      </div>

      {documents.length > 0 && (
        <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap", marginTop: spacing.md }}>
          <MetricCard label="Documents" value={documents.length} />
          <MetricCard label="Completed" value={completedCount} />
          <MetricCard label="Processing" value={processingCount} />
        </div>
      )}

      {hasResults && mandatoryGapCount > 0 && (
        <p role="status" style={{ ...typeScale.meta, color: colors.caution700, marginTop: spacing.md }}>
          {mandatoryGapCount} mandatory requirement{mandatoryGapCount === 1 ? "" : "s"} currently show MANDATORY GAP —
          review the evidence below before deciding.
        </p>
      )}

      {isProcessing && (
        <ProcessingState>Processing — results will appear once analysis completes.</ProcessingState>
      )}

      {!hasResults && !isProcessing && isFailed && (
        <FailedState>Processing failed. Retry from the candidates list.</FailedState>
      )}

      {!hasResults && !isProcessing && !isFailed && <EmptyState role="status">No results available yet.</EmptyState>}

      {hasResults && (
        <>
          <section style={{ marginTop: spacing.xl }}>
            <h2 style={typeScale.sectionTitle}>Requirements &amp; Evidence</h2>
            {assessments.assessments.length === 0 ? (
              <EmptyState>No requirement assessments yet.</EmptyState>
            ) : (
              assessments.assessments.map((a, i) => <AssessmentCard key={i} assessment={a} />)
            )}
          </section>

          <section style={{ marginTop: spacing.xl }}>
            <h2 style={typeScale.sectionTitle}>Career Consistency</h2>
            {findings.findings.length === 0 ? (
              <EmptyState>No consistency findings.</EmptyState>
            ) : (
              findings.findings.map((f, i) => <FindingCard key={i} finding={f} />)
            )}
          </section>
        </>
      )}

      {/* A decision is a human action HR can take independently of whether
          AI results exist yet — never gated behind hasResults. */}
      <DecisionsPanel
        projectId={String(projectId)}
        candidateId={String(candidateId)}
        currentAssessments={assessments?.assessments ?? []}
      />
    </main>
  );
}
