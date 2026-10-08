"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../lib/api";
import { Table, TableHeadRow, HeaderCell, Row, Cell } from "../../../components/DataTable";
import { Card } from "../../../components/Card";
import { MetricCard } from "../../../components/MetricCard";
import { StatusBadge } from "../../../components/StatusBadge";
import { EmptyState } from "../../../components/EmptyState";
import { colors, spacing, typeScale } from "../../../design-tokens";

interface CandidateDocument {
  id: string;
  originalFilename: string;
  fileType: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED_RETRY" | "FAILED_NEEDS_OCR";
  failureReason: string | null;
  uploadedAt: string;
}
interface CandidateLink {
  candidateId: string;
  anonymizedLabel: string;
  documents: CandidateDocument[];
}

interface StagedUploadSummary {
  stagedUploadId: string;
  originalFilename: string;
  status: string;
  uploadedAt: string;
  message: string | null;
}

const MIN_COMPARE = 2;
const MAX_COMPARE = 5;

/**
 * UI Batch 4 — Candidates Workspace.
 *
 * Section E correction carried over from the Batch 3 review: candidate
 * readiness is determined at the CANDIDATE level, not the document level.
 * The previous version of this page rendered one table row per DOCUMENT,
 * so a candidate with 2 documents appeared as 2 rows with a duplicated
 * checkbox/link for the same candidateId. This version renders exactly one
 * row per candidate; document-level detail (filename, status, retry) is
 * summarized within that one row, never duplicated as separate rows.
 *
 * Section G (review signals): per-candidate assessment/evidence data is
 * NOT available from this page's existing data source
 * (GET /projects/:id/candidates only returns document status, not
 * Assessment rows) — getting it would require one /assessments call per
 * candidate (N+1), which Batch 3's own review already ruled out for the
 * Overview page on the same grounds. Same decision carried forward here:
 * no per-candidate assessment/review signal is shown on this list. The
 * Candidate Profile page (unchanged) remains where that detail lives.
 *
 * "Needs Review" here means exactly one real, existing thing: a staged
 * upload pending identity-match review (GET /projects/:id/staged-uploads,
 * status PENDING_REVIEW) — not a candidate row at all yet, since it hasn't
 * been promoted to a Candidate. Shown as its own section, never merged
 * into the candidate table.
 */
export default function CandidatesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [links, setLinks] = useState<CandidateLink[] | null>(null);
  const [stagedUploads, setStagedUploads] = useState<StagedUploadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<{ staged: number; rejected: { filename: string; error: string }[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Selection is a plain array, never sorted/reordered by any candidate's
  // processing status or assessment outcome — Compare Selected passes this
  // exact order through to the comparison view.
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);

  function toggleSelected(candidateId: string) {
    setSelectedCandidateIds((prev) =>
      prev.includes(candidateId) ? prev.filter((id) => id !== candidateId) : [...prev, candidateId],
    );
  }

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<CandidateLink[]>(`/projects/${projectId}/candidates`);
      setLinks(data);
      setError(null);
    } catch {
      setError("Could not load candidates.");
    }
    apiFetch<StagedUploadSummary[]>(`/projects/${projectId}/staged-uploads`).then(setStagedUploads).catch(() => {});
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is still in flight — a real status screen, not a
  // fire-and-forget upload confirmation.
  useEffect(() => {
    const hasInFlight = (links ?? []).some((l) =>
      l.documents.some((d) => d.status === "QUEUED" || d.status === "PROCESSING"),
    );
    if (!hasInFlight) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [links, load]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) return;

    const form = new FormData();
    for (const file of Array.from(files)) form.append("files", file);

    setUploading(true);
    setError(null);
    try {
      const result = await apiFetch<{ staged: unknown[]; rejected: { filename: string; error: string }[] }>(
        `/projects/${projectId}/candidates/upload`,
        { method: "POST", body: form },
      );
      setUploadResult({ staged: result.staged.length, rejected: result.rejected });
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `Upload failed (${e.status}).` : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function retry(candidateId: string, documentId: string) {
    try {
      await apiFetch(`/projects/${projectId}/candidates/${candidateId}/documents/${documentId}/retry`, {
        method: "POST",
      });
      await load();
    } catch {
      setError("Could not retry.");
    }
  }

  if (error) {
    return (
      <main style={{ maxWidth: 900 }}>
        <p role="alert" style={{ color: colors.danger700 }}>{error}</p>
        <button onClick={() => load()}>Retry</button>
      </main>
    );
  }

  // --- Candidate-level rollup (never document-level — see file header) ---
  type Rollup = "PROCESSING" | "READY" | "FAILED";
  function rollupFor(l: CandidateLink): Rollup {
    const isProcessing = l.documents.some((d) => d.status === "QUEUED" || d.status === "PROCESSING");
    if (isProcessing) return "PROCESSING";
    const isReady = l.documents.some((d) => d.status === "COMPLETED");
    if (isReady) return "READY";
    return "FAILED";
  }

  const candidateCount = links?.length ?? null;
  const processingCandidates = links?.filter((l) => rollupFor(l) === "PROCESSING").length ?? 0;
  const readyCandidates = links?.filter((l) => rollupFor(l) === "READY").length ?? 0;
  const failedDocumentCount =
    links?.flatMap((l) => l.documents).filter((d) => d.status === "FAILED_RETRY" || d.status === "FAILED_NEEDS_OCR").length ?? 0;
  const needsReviewCount = stagedUploads?.filter((s) => s.status === "PENDING_REVIEW").length ?? 0;
  const comparisonAvailable = readyCandidates >= MIN_COMPARE;

  return (
    <main style={{ maxWidth: 900 }}>
      <p style={{ color: colors.ink600, marginTop: 0 }}>
        Candidates uploaded to this project, their processing state, and a path to compare them.
      </p>

      {/* B. Candidate Summary */}
      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.lg }}>
        <MetricCard label="Candidates" value={candidateCount ?? "…"} />
        <MetricCard label="Processing" value={links ? processingCandidates : "…"} />
        <MetricCard label="Ready" value={links ? readyCandidates : "…"} />
        <MetricCard label="Needs Review" value={needsReviewCount} />
        <MetricCard label="Failed Documents" value={failedDocumentCount} />
      </div>

      {/* A. Upload action */}
      <Card style={{ marginBottom: spacing.lg }}>
        <form onSubmit={handleUpload} style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileInputRef} type="file" accept=".pdf,.docx" multiple />
          <button type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload CVs"}
          </button>
        </form>
      </Card>
      {uploadResult && (
        <p style={{ color: uploadResult.rejected.length > 0 ? colors.caution700 : colors.success700 }}>
          Staged {uploadResult.staged} for processing.{" "}
          {uploadResult.rejected.length > 0 &&
            `Rejected: ${uploadResult.rejected.map((r) => `${r.filename} (${r.error})`).join(", ")}`}
        </p>
      )}

      {/* L. Document Failure Notice — distinct from candidate assessment */}
      {failedDocumentCount > 0 && (
        <Card style={{ marginBottom: spacing.lg, background: colors.dangerBg, border: `1px solid ${colors.danger700}` }}>
          <p style={{ margin: 0, color: colors.danger700 }}>
            {failedDocumentCount} document(s) failed processing and may need a retry. This reflects a technical
            processing issue with that document — it is not a candidate's assessment, evidence, or experience being
            judged.
          </p>
        </Card>
      )}

      {/* Needs Review — staged uploads pending identity-match review, not yet promoted to candidates */}
      {needsReviewCount > 0 && (
        <Card style={{ marginBottom: spacing.lg, background: colors.cautionBg, border: `1px solid ${colors.caution700}` }}>
          <p style={{ margin: 0, color: colors.caution700 }}>
            {needsReviewCount} upload(s) need administrator review for a possible duplicate candidate before they can
            be added to this project.
          </p>
        </Card>
      )}

      {/* H. Comparison action */}
      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.sm }}>
        <Link
          href={`/projects/${projectId}/candidates/compare?candidateIds=${selectedCandidateIds.join(",")}`}
          aria-disabled={selectedCandidateIds.length < MIN_COMPARE}
          onClick={(e) => {
            if (selectedCandidateIds.length < MIN_COMPARE) e.preventDefault();
          }}
          style={{
            pointerEvents: selectedCandidateIds.length < MIN_COMPARE ? "none" : "auto",
            opacity: selectedCandidateIds.length < MIN_COMPARE ? 0.5 : 1,
          }}
        >
          <button type="button" disabled={selectedCandidateIds.length < MIN_COMPARE}>
            Compare Selected ({selectedCandidateIds.length})
          </button>
        </Link>
        <span style={{ fontSize: 13, color: colors.ink400 }}>
          Select {MIN_COMPARE}–{MAX_COMPARE} candidates to compare.
          {links && !comparisonAvailable && readyCandidates > 0 &&
            ` ${readyCandidates} candidate(s) are ready so far.`}
        </span>
      </div>

      {/* C. Candidate List — one row per candidate, never per document */}
      {links === null ? (
        <p style={{ color: colors.ink600 }}>Loading…</p>
      ) : links.length === 0 ? (
        <EmptyState>No candidates have been added yet. Upload CVs above to get started.</EmptyState>
      ) : (
        <div style={{ overflowX: "auto" }}>
        <Table>
          <thead>
            <TableHeadRow>
              <HeaderCell></HeaderCell>
              <HeaderCell>Candidate</HeaderCell>
              <HeaderCell>Documents</HeaderCell>
              <HeaderCell>Status</HeaderCell>
              <HeaderCell>Last Update</HeaderCell>
              <HeaderCell></HeaderCell>
            </TableHeadRow>
          </thead>
          <tbody>
            {links.map((l) => {
              const rollup = rollupFor(l);
              // Both failed statuses are shown so no failure is silently
              // hidden — only FAILED_RETRY gets a Retry action, matching
              // the existing backend (FAILED_NEEDS_OCR has no retry route;
              // no retry functionality is invented for it here).
              const failedDocs = l.documents.filter((d) => d.status === "FAILED_RETRY" || d.status === "FAILED_NEEDS_OCR");
              // documents are already ordered uploadedAt desc by the API.
              const lastUpdate = l.documents[0]?.uploadedAt;
              return (
                <Row key={l.candidateId}>
                  <Cell>
                    <input
                      type="checkbox"
                      checked={selectedCandidateIds.includes(l.candidateId)}
                      disabled={!selectedCandidateIds.includes(l.candidateId) && selectedCandidateIds.length >= MAX_COMPARE}
                      onChange={() => toggleSelected(l.candidateId)}
                      aria-label={`Select ${l.anonymizedLabel} for comparison`}
                    />
                  </Cell>
                  <Cell>
                    <Link href={`/projects/${projectId}/candidates/${l.candidateId}`} style={{ color: colors.brand700 }}>
                      {l.anonymizedLabel}
                    </Link>
                  </Cell>
                  <Cell>{l.documents.length}</Cell>
                  <Cell>
                    <StatusBadge status={rollup} />
                    {rollup === "PROCESSING" && (
                      <div style={{ ...typeScale.tiny, marginTop: 4 }}>Processing is still underway.</div>
                    )}
                    {failedDocs.length > 0 && (
                      <div style={{ marginTop: 4 }}>
                        {failedDocs.map((d) => (
                          <div key={d.id} style={{ ...typeScale.tiny, color: colors.danger700 }}>
                            {d.originalFilename} failed
                            {d.status === "FAILED_RETRY" ? (
                              <>
                                {" "}
                                <button onClick={() => retry(l.candidateId, d.id)} style={{ fontSize: 11 }}>
                                  Retry
                                </button>
                              </>
                            ) : (
                              " (needs OCR — not supported yet)"
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </Cell>
                  <Cell>{lastUpdate ? new Date(lastUpdate).toLocaleDateString() : "—"}</Cell>
                  <Cell>
                    <Link
                      href={`/projects/${projectId}/candidates/${l.candidateId}`}
                      style={{ color: colors.brand700 }}
                      aria-label={`Open ${l.anonymizedLabel}`}
                    >
                      Open →
                    </Link>
                  </Cell>
                </Row>
              );
            })}
          </tbody>
        </Table>
        </div>
      )}
    </main>
  );
}
