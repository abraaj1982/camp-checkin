"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch, ApiError } from "../../../../lib/api";

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

// Processing Status screen (Phase 3, Section 8): each candidate document is
// independent — one failure never blocks the rest of the batch (Section 41
// of the master instruction), and that independence is visible here as a
// per-row status, not a single batch progress bar.
export default function CandidatesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [links, setLinks] = useState<CandidateLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadResult, setUploadResult] = useState<{ uploaded: number; rejected: { filename: string; error: string }[] } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      const result = await apiFetch<{ uploaded: unknown[]; rejected: { filename: string; error: string }[] }>(
        `/projects/${projectId}/candidates/upload`,
        { method: "POST", body: form },
      );
      setUploadResult({ uploaded: result.uploaded.length, rejected: result.rejected });
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
    <main style={{ padding: 32, maxWidth: 900 }}>
      <p><Link href={`/projects/${projectId}`}>← Project overview</Link></p>
      <h1>Candidates</h1>

      <form onSubmit={handleUpload} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <input ref={fileInputRef} type="file" accept=".pdf,.docx" multiple />
        <button type="submit" disabled={uploading}>
          {uploading ? "Uploading…" : "Upload CVs"}
        </button>
      </form>
      {uploadResult && (
        <p style={{ color: uploadResult.rejected.length > 0 ? "#a15c00" : "#2a7a2a" }}>
          Uploaded {uploadResult.uploaded}.{" "}
          {uploadResult.rejected.length > 0 &&
            `Rejected: ${uploadResult.rejected.map((r) => `${r.filename} (${r.error})`).join(", ")}`}
        </p>
      )}
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <p style={{ color: "#555" }}>
        {Object.entries(counts)
          .map(([status, count]) => `${STATUS_LABEL[status as CandidateDocument["status"]]}: ${count}`)
          .join(" · ") || "No candidates yet."}
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
            <th style={{ padding: 8 }}>Candidate</th>
            <th style={{ padding: 8 }}>File</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Reason</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {links.flatMap((l) =>
            l.documents.map((d) => (
              <tr key={d.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 8 }}>
                  <Link href={`/projects/${projectId}/candidates/${l.candidateId}`}>{l.anonymizedLabel}</Link>
                </td>
                <td style={{ padding: 8 }}>{d.originalFilename}</td>
                <td style={{ padding: 8 }}>{STATUS_LABEL[d.status]}</td>
                <td style={{ padding: 8, color: "#a00" }}>{d.failureReason ?? ""}</td>
                <td style={{ padding: 8 }}>
                  {d.status === "FAILED_RETRY" && (
                    <button onClick={() => retry(l.candidateId, d.id)}>Retry</button>
                  )}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </main>
  );
}
