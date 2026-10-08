"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../../lib/api";
import { EvidenceCard as SharedEvidenceCard } from "../../../../components/EvidenceCard";
import { Disclaimer, COVERAGE_DISCLAIMER_TEXT, SCORE_DISCLAIMER_TEXT } from "../../../../components/Disclaimer";
import { EmptyState } from "../../../../components/EmptyState";
import { Card } from "../../../../components/Card";
import { StatusBadge } from "../../../../components/StatusBadge";
import { colors, spacing, typeScale } from "../../../../design-tokens";

/**
 * UI Batch 5 — Comparison Workspace. Every change below is additive/visual
 * only: no rendered text string that the existing 25-test suite asserts on
 * was altered, removed, or restructured — only wrapped in the established
 * Card/StatusBadge primitives (Batch 1) for Workspace visual consistency,
 * plus two new, neutral lines of explanatory copy (the page intro and the
 * V1 Score explanation strap) that did not exist before. No new rendered
 * text matches any of the existing forbidden-language assertions (rank/
 * recommend/suitable/best/hire/winner), and no existing text was touched.
 */

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
 *
 * V1 Scoring integration — each candidate also carries `score` (see
 * apps/api/src/modules/assessments/scoring.ts /
 * packages/shared-types/src/scoring.ts, frozen at commit
 * d0e5a564b6563ddceae1ea9ebc45478b44e9d399). This is a SEPARATE concept
 * from Evidence Coverage — never combined, never replacing it — and is
 * display-only here too: it never reorders, ranks, or filters the
 * candidate columns, and a blocked/non-computable result
 * (LIVE_REQUIREMENT_NOT_YET_APPROVED / PII_PURGED) is rendered as its own
 * distinct, named state, never as 0% or a blank. apps/web has no
 * dependency on @recruitment-platform/shared-types (consistent with every
 * other field on this page being a locally mirrored interface rather than
 * a cross-package import), so `ComparisonScore` below is a local type
 * mirroring the API's trimmed field, not a duplicate scoring union.
 */

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

type ComparisonScore =
  | { computable: true; score: number; numerator: number; denominator: number }
  | { computable: false; reason: "LIVE_REQUIREMENT_NOT_YET_APPROVED"; requirementIds: string[] }
  | { computable: false; reason: "PII_PURGED" };

interface CandidateSummary {
  candidateId: string;
  anonymizedLabel: string;
  hasCurrentRun: boolean;
  isProcessing: boolean;
  isFailed: boolean;
  evidenceCoverage: EvidenceCoverage | null;
  score: ComparisonScore;
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
    <main style={{ maxWidth: 1200 }}>
      <p style={{ color: colors.ink600, marginTop: 0 }}>
        A structured, decision-support comparison of the selected candidates against this project&apos;s approved
        requirements. This view explains evidence and assessment status — it does not make a hiring decision.
      </p>
      {loading && <p>Loading…</p>}
      {error && <p style={{ color: colors.danger700 }}>{error}</p>}

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${data.candidates.length}, 1fr)`, gap: spacing.sm, marginBottom: spacing.lg }}>
            <div />
            {/* Candidates always render in the exact order the API returned
                them — selection order — never sorted by status or outcome. */}
            {data.candidates.map((c, i) => (
              <Card key={c.candidateId} style={{ borderTop: `4px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, borderRadius: 0 }}>
                <strong>{c.anonymizedLabel}</strong>
                <div style={{ fontSize: 12, color: colors.ink600 }}>
                  {c.isProcessing && <span role="status">Processing…</span>}
                  {!c.isProcessing && c.isFailed && <span role="status" style={{ color: colors.danger700 }}>Processing failed</span>}
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
                      <span style={{ color: colors.danger700, marginLeft: 6 }}>
                        · Mandatory Gaps: {c.evidenceCoverage.mandatoryGapCount}
                      </span>
                    )}
                    {c.evidenceCoverage.lowConfidenceCoveredCount > 0 && (
                      <span style={{ color: colors.caution700, marginLeft: 6 }}>
                        · Low Confidence: {c.evidenceCoverage.lowConfidenceCoveredCount}
                      </span>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {c.score.computable ? (
                    <span>V1 Score: {Math.round(c.score.score)}%</span>
                  ) : c.score.reason === "LIVE_REQUIREMENT_NOT_YET_APPROVED" ? (
                    <span style={{ color: colors.caution700 }}>
                      V1 Score: Not computable — {c.score.requirementIds.length} live requirement(s) not yet approved
                    </span>
                  ) : (
                    <span style={{ color: colors.ink600 }}>V1 Score: Not available (candidate data purged)</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <p style={{ ...typeScale.tiny, marginTop: -spacing.sm, marginBottom: spacing.sm }}>
            V1 Score: decision-support score based on the approved project requirements and eligible assessment
            evidence.
          </p>
          {data.candidates.some((c) => c.evidenceCoverage) && <Disclaimer text={COVERAGE_DISCLAIMER_TEXT} />}
          <Disclaimer text={SCORE_DISCLAIMER_TEXT} />

          <h2 style={typeScale.sectionTitle}>Requirements &amp; Evidence</h2>
          {data.requirementRows.length === 0 ? (
            <EmptyState>No requirement assessments to compare yet.</EmptyState>
          ) : (
            data.requirementRows.map((row) => (
              <section key={`${row.requirementId}:${row.requirementVersionId ?? "none"}`} style={{ marginBottom: spacing.xl }}>
                <h3 style={{ marginBottom: 2 }}>
                  {row.description}
                  {row.versionNumber !== null && (
                    <span style={{ fontWeight: 400, fontSize: 13, color: colors.ink400 }}> (version {row.versionNumber})</span>
                  )}
                </h3>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: colors.ink600 }}>
                  {row.mandatory ? "Mandatory" : "Optional"} · {row.category}
                  {row.hrApprovedWeight !== null && ` · Weight: ${row.hrApprovedWeight}`}
                </p>
                <div style={{ display: "grid", gridTemplateColumns: `200px repeat(${data.candidates.length}, 1fr)`, gap: spacing.sm }}>
                  <div />
                  {data.candidates.map((c, i) => {
                    const results = row.resultsByCandidate[c.candidateId] ?? [];
                    const requirementCoverage = c.evidenceCoverage?.perRequirement.find(
                      (r) => r.requirementId === row.requirementId,
                    );
                    return (
                      <div
                        key={c.candidateId}
                        style={{ borderLeft: `3px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingLeft: spacing.sm }}
                      >
                        {results.length === 0 ? (
                          <EmptyState>No assessment for this version.</EmptyState>
                        ) : (
                          results.map((result, ri) => (
                            <div key={ri} style={{ marginBottom: results.length > 1 ? 10 : 0 }}>
                              <p style={{ margin: "0 0 4px", fontWeight: 600 }}>
                                <StatusBadge status={result.status} />
                                {/* Phase 12 (C3) — profile/publication-authority indicator only; never an evidence-quality signal (EvidenceStrength/status are unaffected). */}
                                <span
                                  style={{
                                    marginLeft: 8,
                                    fontSize: 11,
                                    fontWeight: 400,
                                    color: result.isAuthoritative ? colors.success700 : colors.caution700,
                                  }}
                                >
                                  <span aria-hidden="true">{result.isAuthoritative ? "●" : "○"}</span>{" "}
                                  {result.isAuthoritative ? "Current profile" : "Other current document"}
                                </span>
                              </p>
                              {requirementCoverage && (
                                <p style={{ margin: "0 0 6px", fontSize: 12 }}>
                                  <span style={{ color: requirementCoverage.covered ? colors.success700 : colors.ink600 }}>
                                    {requirementCoverage.covered ? "Covered" : "Not Covered"}
                                  </span>
                                  {requirementCoverage.mandatoryGap && (
                                    <span style={{ color: colors.danger700, marginLeft: 6 }}>· Mandatory Gap</span>
                                  )}
                                  {requirementCoverage.contested && (
                                    <span style={{ color: colors.danger700, marginLeft: 6 }}>· Contradictory Evidence — Review Required</span>
                                  )}
                                  {requirementCoverage.lowConfidenceAssessment && (
                                    <span style={{ color: colors.caution700, marginLeft: 6 }}>· Low Confidence — Review Evidence</span>
                                  )}
                                </p>
                              )}
                              {result.evidence.map((e, ei) => (
                                <SharedEvidenceCard key={ei} item={e} showRole />
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

          <h2 style={typeScale.sectionTitle}>Career Consistency</h2>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${data.candidates.length}, 1fr)`, gap: spacing.sm }}>
            {data.candidates.map((c, i) => {
              const findings = data.consistencyFindingsByCandidate[c.candidateId] ?? [];
              return (
                <div key={c.candidateId} style={{ borderLeft: `3px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingLeft: spacing.sm }}>
                  {findings.length === 0 ? (
                    <EmptyState>No findings.</EmptyState>
                  ) : (
                    findings.map((f, fi) => (
                      <div key={fi} style={{ border: `1px solid ${colors.border}`, borderRadius: 4, padding: spacing.sm, marginBottom: 6 }}>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
                          {f.findingType.replaceAll("_", " ")} — <span style={{ fontWeight: 400 }}>{f.severity.replaceAll("_", " ")}</span>
                          <span
                            style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: f.isAuthoritative ? colors.success700 : colors.caution700 }}
                          >
                            {f.isAuthoritative ? "Current profile" : "Other current document"}
                          </span>
                        </p>
                        <p style={{ margin: "4px 0", fontSize: 13 }}>{f.description}</p>
                        {f.evidenceText && <p style={{ margin: "4px 0", fontSize: 13, color: colors.ink600 }}>&ldquo;{f.evidenceText}&rdquo;</p>}
                        <p style={{ margin: 0, fontSize: 11, color: colors.ink400 }}>
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
