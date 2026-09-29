"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../../lib/api";

/**
 * Phase 5 completion — Candidate Comparison viewer. Deterministic,
 * read-only, evidence-first: renders exactly what
 * POST /projects/:projectId/candidates/compare returns, in the exact
 * candidate order the API sends (selection order) — never re-sorted by
 * status/strength/finding-count/any other outcome-derived value. No rank
 * or recommendation is computed or displayed anywhere on this page.
 *
 * Phase 9 — each candidate also carries `evidenceCoverage`. This is
 * displayed as "Evidence Coverage: X%", never "Score" and never "X/100" —
 * see packages/shared-types/src/evidence-coverage.ts for the definition.
 * It is never used to reorder or auto-sort the candidate columns.
 */

const COVERAGE_DISCLAIMER =
  "Evidence Coverage reflects weighted evidence against approved requirements — not a suitability, quality, or hiring recommendation.";

interface EvidenceItem {
  role: "SUPPORTING" | "CONSIDERED_REJECTED";
  rationale: string | null;
  evidenceStrength: string;
  confidence: string;
  evidenceType: string;
  sourcePage: number | null;
  evidenceText: string | null;
  source: string | null;
}

// Phase 12 (C3) — a profile/publication-authority indicator only (never an
// evidence-quality signal): whether this result's ProcessingRun is the
// candidate's current Phase 11 authoritative one. A candidate can have
// more than one current-run result per requirement (the hybrid model —
// non-authoritative/superseded evidence stays visible, never hidden or
// silently dropped); each is labeled independently.
interface AssessmentResult {
  status: string;
  evidence: EvidenceItem[];
  isAuthoritative: boolean;
}

interface RequirementCoverageResult {
  requirementId: string;
  covered: boolean;
  contested: boolean;
  mandatoryGap: boolean;
  lowConfidenceAssessment: boolean;
}

interface EvidenceCoverage {
  coveragePercentage: number;
  status: "COMPLETE" | "INCOMPLETE";
  scoredWeight: number;
  totalWeight: number;
  mandatoryGapCount: number;
  lowConfidenceCoveredCount: number;
  perRequirement: RequirementCoverageResult[];
}

interface CandidateSummary {
  candidateId: string;
  anonymizedLabel: string;
  hasCurrentRun: boolean;
  isProcessing: boolean;
  isFailed: boolean;
  evidenceCoverage: EvidenceCoverage | null;
}

interface RequirementRow {
  requirementId: string;
  requirementVersionId: string | null;
  versionNumber: number | null;
  description: string;
  mandatory: boolean;
  category: string;
  hrApprovedWeight: string | null;
  // Phase 12 (C3) — an array per candidate, not a single value: more than
  // one current-run result can legitimately exist (see AssessmentResult).
  resultsByCandidate: Record<string, AssessmentResult[]>;
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

interface CompareResponse {
  candidates: CandidateSummary[];
  requirementRows: RequirementRow[];
  consistencyFindingsByCandidate: Record<string, ConsistencyFinding[]>;
}

function sourceLabel(source: string | null, sourcePage: number | null): string {
  if (!source) return "No source";
  return sourcePage !== null ? `${source}, page ${sourcePage}` : source;
}

// Distinct, visible per-candidate accent (not an outcome/status signal —
// purely so a reader never mistakes one candidate's independently-scoped
// "Company A" for another's, per the approved employer-tokenization
// decision: tokens are never shared across candidates, and the columns
// must make that visually obvious).
const COLUMN_ACCENTS = ["#2b6cb0", "#8a5a00", "#276749", "#742a2a", "#553c9a"];

export default function CandidateComparisonPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const [data, setData] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const candidateIds = (searchParams.get("candidateIds") ?? "").split(",").filter(Boolean);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch<CompareResponse>(`/projects/${projectId}/candidates/compare`, {
          method: "POST",
          body: JSON.stringify({ candidateIds }),
        });
        if (!cancelled) setData(res);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 400) {
          setError("This comparison could not be completed — check that 2–5 candidates from this project are selected.");
        } else {
          setError("Could not load the comparison.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (candidateIds.length >= 2) load();
    else {
      setLoading(false);
      setError("Select at least 2 candidates to compare.");
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, searchParams.toString()]);

  return (
    <main style={{ padding: 32, maxWidth: 1200 }}>
      <p><Link href={`/projects/${projectId}/candidates`}>← Back to candidates</Link></p>
      <h1>Compare Candidates</h1>

      {loading && <p>Loading…</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${data.candidates.length}, 1fr)`, gap: 8, marginBottom: 16 }}>
            <div />
            {/* Candidates always render in the exact order the API returned
                them — selection order — never sorted by status or outcome. */}
            {data.candidates.map((c, i) => (
              <div key={c.candidateId} style={{ borderTop: `4px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingTop: 8 }}>
                <strong>{c.anonymizedLabel}</strong>
                <div style={{ fontSize: 12, color: "#555" }}>
                  {c.isProcessing && <span role="status">Processing…</span>}
                  {!c.isProcessing && c.isFailed && <span role="status" style={{ color: "crimson" }}>Processing failed</span>}
                  {!c.isProcessing && !c.isFailed && !c.hasCurrentRun && <span role="status">No results yet</span>}
                  {!c.isProcessing && c.hasCurrentRun && <span>Results current</span>}
                </div>
                {c.evidenceCoverage && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    <span>
                      Evidence Coverage: {Math.round(c.evidenceCoverage.coveragePercentage)}%
                      {c.evidenceCoverage.status === "INCOMPLETE" &&
                        ` (based on ${c.evidenceCoverage.scoredWeight} of ${c.evidenceCoverage.totalWeight} weighted)`}
                    </span>
                    {c.evidenceCoverage.mandatoryGapCount > 0 && (
                      <span style={{ color: "#742a2a", marginLeft: 6 }}>
                        · Mandatory Gaps: {c.evidenceCoverage.mandatoryGapCount}
                      </span>
                    )}
                    {c.evidenceCoverage.lowConfidenceCoveredCount > 0 && (
                      <span style={{ color: "#8a5a00", marginLeft: 6 }}>
                        · Low Confidence: {c.evidenceCoverage.lowConfidenceCoveredCount}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {data.candidates.some((c) => c.evidenceCoverage) && (
            <p style={{ fontSize: 12, color: "#888", marginTop: -8, marginBottom: 16 }}>{COVERAGE_DISCLAIMER}</p>
          )}

          <h2>Requirements &amp; Evidence</h2>
          {data.requirementRows.length === 0 ? (
            <p style={{ color: "#888" }}>No requirement assessments to compare yet.</p>
          ) : (
            data.requirementRows.map((row) => (
              <section key={`${row.requirementId}:${row.requirementVersionId ?? "none"}`} style={{ marginBottom: 24 }}>
                <h3 style={{ marginBottom: 2 }}>
                  {row.description}
                  {row.versionNumber !== null && (
                    <span style={{ fontWeight: 400, fontSize: 13, color: "#888" }}> (version {row.versionNumber})</span>
                  )}
                </h3>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "#555" }}>
                  {row.mandatory ? "Mandatory" : "Optional"} · {row.category}
                  {row.hrApprovedWeight !== null && ` · Weight: ${row.hrApprovedWeight}`}
                </p>
                <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${data.candidates.length}, 1fr)`, gap: 8 }}>
                  <div />
                  {data.candidates.map((c, i) => {
                    const results = row.resultsByCandidate[c.candidateId] ?? [];
                    const requirementCoverage = c.evidenceCoverage?.perRequirement.find(
                      (r) => r.requirementId === row.requirementId,
                    );
                    return (
                      <div
                        key={c.candidateId}
                        style={{ borderLeft: `3px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingLeft: 8 }}
                      >
                        {results.length === 0 ? (
                          <p style={{ fontSize: 13, color: "#888" }}>No assessment for this version.</p>
                        ) : (
                          results.map((result, ri) => (
                            <div key={ri} style={{ marginBottom: results.length > 1 ? 10 : 0 }}>
                              <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
                                {result.status.replaceAll("_", " ")}
                                {/* Phase 12 (C3) — profile/publication-authority indicator only; never an evidence-quality signal (EvidenceStrength/status are unaffected). */}
                                <span
                                  style={{
                                    marginLeft: 8,
                                    fontSize: 11,
                                    fontWeight: 400,
                                    color: result.isAuthoritative ? "#276749" : "#8a5a00",
                                  }}
                                >
                                  {result.isAuthoritative ? "Current profile" : "Other current document"}
                                </span>
                              </p>
                              {requirementCoverage && (
                                <p style={{ margin: "0 0 6px", fontSize: 12 }}>
                                  <span style={{ color: requirementCoverage.covered ? "#276749" : "#555" }}>
                                    {requirementCoverage.covered ? "Covered" : "Not Covered"}
                                  </span>
                                  {requirementCoverage.mandatoryGap && (
                                    <span style={{ color: "#742a2a", marginLeft: 6 }}>· Mandatory Gap</span>
                                  )}
                                  {requirementCoverage.contested && (
                                    <span style={{ color: "#c05621", marginLeft: 6 }}>· Contradictory Evidence — Review Required</span>
                                  )}
                                  {requirementCoverage.lowConfidenceAssessment && (
                                    <span style={{ color: "#8a5a00", marginLeft: 6 }}>· Low Confidence — Review Evidence</span>
                                  )}
                                </p>
                              )}
                              {result.evidence.map((e, ei) => (
                                <div key={ei} style={{ border: "1px solid #eee", borderRadius: 4, padding: 8, marginBottom: 6 }}>
                                  <p style={{ margin: 0, fontSize: 12, color: "#555" }}>
                                    {e.role.replaceAll("_", " ")} · {e.evidenceStrength} · {e.confidence}
                                  </p>
                                  {e.evidenceText && <p style={{ margin: "4px 0", fontSize: 13 }}>&ldquo;{e.evidenceText}&rdquo;</p>}
                                  {e.rationale && <p style={{ margin: "4px 0", fontSize: 13, color: "#555" }}>{e.rationale}</p>}
                                  <p style={{ margin: 0, fontSize: 11, color: "#888" }}>{sourceLabel(e.source, e.sourcePage)}</p>
                                </div>
                              ))}
                            </div>
                          ))
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          )}

          <h2>Career Consistency</h2>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${data.candidates.length}, 1fr)`, gap: 8 }}>
            {data.candidates.map((c, i) => {
              const findings = data.consistencyFindingsByCandidate[c.candidateId] ?? [];
              return (
                <div key={c.candidateId} style={{ borderLeft: `3px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingLeft: 8 }}>
                  {findings.length === 0 ? (
                    <p style={{ fontSize: 13, color: "#888" }}>No findings.</p>
                  ) : (
                    findings.map((f, fi) => (
                      <div key={fi} style={{ border: "1px solid #ddd", borderRadius: 4, padding: 8, marginBottom: 6 }}>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                          {f.findingType.replaceAll("_", " ")} — <span style={{ fontWeight: 400 }}>{f.severity.replaceAll("_", " ")}</span>
                          <span
                            style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: f.isAuthoritative ? "#276749" : "#8a5a00" }}
                          >
                            {f.isAuthoritative ? "Current profile" : "Other current document"}
                          </span>
                        </p>
                        <p style={{ margin: "4px 0", fontSize: 13 }}>{f.description}</p>
                        {f.evidenceText && <p style={{ margin: "4px 0", fontSize: 13, color: "#555" }}>&ldquo;{f.evidenceText}&rdquo;</p>}
                        <p style={{ margin: 0, fontSize: 11, color: "#888" }}>
                          Confidence: {f.confidence} · {sourceLabel(f.source, f.sourcePage)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
