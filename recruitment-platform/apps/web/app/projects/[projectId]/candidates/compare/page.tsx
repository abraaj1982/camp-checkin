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
 * status/strength/finding-count/any other outcome-derived value. No
 * aggregate count, score, rank, or recommendation is computed or
 * displayed anywhere on this page.
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

interface CandidateSummary {
  candidateId: string;
  anonymizedLabel: string;
  hasCurrentRun: boolean;
  isProcessing: boolean;
  isFailed: boolean;
}

interface RequirementRow {
  requirementId: string;
  requirementVersionId: string | null;
  versionNumber: number | null;
  description: string;
  mandatory: boolean;
  category: string;
  hrApprovedWeight: string | null;
  resultsByCandidate: Record<string, { status: string; evidence: EvidenceItem[] } | null>;
}

interface ConsistencyFinding {
  findingType: string;
  severity: string;
  description: string;
  sourcePage: number | null;
  evidenceText: string | null;
  confidence: string;
  source: string | null;
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
              </div>
            ))}
          </div>

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
                    const result = row.resultsByCandidate[c.candidateId];
                    return (
                      <div
                        key={c.candidateId}
                        style={{ borderLeft: `3px solid ${COLUMN_ACCENTS[i % COLUMN_ACCENTS.length]}`, paddingLeft: 8 }}
                      >
                        {!result ? (
                          <p style={{ fontSize: 13, color: "#888" }}>No assessment for this version.</p>
                        ) : (
                          <>
                            <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{result.status.replaceAll("_", " ")}</p>
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
                          </>
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
