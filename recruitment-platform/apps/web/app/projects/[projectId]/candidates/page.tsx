"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../lib/api";
import { Table, TableHeadRow, HeaderCell, Row, Cell } from "../../../components/DataTable";
import { Card } from "../../../components/Card";
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

const STATUS_LABEL: Record<CandidateDocument["status"], string> = {
  QUEUED: "Queued",
  PROCESSING: "Processing",
  COMPLETED: "Completed",
  FAILED_RETRY: "Failed — Retry",
  FAILED_NEEDS_OCR: "Failed — needs OCR (not supported yet)",
};

const MIN_COMPARE = 2;
const MAX_COMPARE = 5;

// Processing Status screen (Phase 3, Section 8): each candidate document is
// independent — one failure never blocks the rest of the batch (Section 41
// of the master instruction), and that independence is visible here as a
// per-row status, not a single batch progress bar.
export default function CandidatesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [links, setLinks] = useState<CandidateLink[]>([]);
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
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is still in flight — a real status screen, not a
  // fire-and-forget upload confirmation.
  useEffect(() => {
    const hasInFlight = links.some((l) =>
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

  const counts = links.reduce<Record<string, number>>((acc, l) => {
    for (const d of l.documents) acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <main style={{ padding: spacing.xxl, maxWidth: 900, fontFamily: "system-ui, sans-serif" }}>
      <p><Link href={`/projects/${projectId}`} style={{ color: colors.brand700 }}>← Project overview</Link></p>
      <h1 style={typeScale.pageTitle}>Candidates</h1>

      <Card style={{ marginBottom: spacing.lg }}>
        <form onSubmit={handleUpload} style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
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
      {error && <p style={{ color: colors.danger700 }}>{error}</p>}

      <p style={{ color: colors.ink600 }}>
        {Object.entries(counts)
          .map(([status, count]) => `${STATUS_LABEL[status as CandidateDocument["status"]]}: ${count}`)
          .join(" · ") || "No candidates yet."}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
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
        <span style={{ fontSize: 13, color: colors.ink400 }}>Select {MIN_COMPARE}–{MAX_COMPARE} candidates to compare.</span>
      </div>

      {links.length === 0 ? (
        <EmptyState>No candidates yet.</EmptyState>
      ) : (
        <Table>
          <thead>
            <TableHeadRow>
              <HeaderCell></HeaderCell>
              <HeaderCell>Candidate</HeaderCell>
              <HeaderCell>File</HeaderCell>
              <HeaderCell>Status</HeaderCell>
              <HeaderCell>Reason</HeaderCell>
              <HeaderCell></HeaderCell>
            </TableHeadRow>
          </thead>
          <tbody>
            {links.flatMap((l) =>
              l.documents.map((d) => (
                <Row key={d.id}>
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
                  <Cell>{d.originalFilename}</Cell>
                  <Cell>{STATUS_LABEL[d.status]}</Cell>
                  <Cell style={{ color: colors.danger700 }}>{d.failureReason ?? ""}</Cell>
                  <Cell>
                    {d.status === "FAILED_RETRY" && (
                      <button onClick={() => retry(l.candidateId, d.id)}>Retry</button>
                    )}
                  </Cell>
                </Row>
              )),
            )}
          </tbody>
        </Table>
      )}
    </main>
  );
}
