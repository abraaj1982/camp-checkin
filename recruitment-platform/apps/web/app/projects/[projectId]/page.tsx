"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { Card } from "../../components/Card";
import { MetricCard } from "../../components/MetricCard";
import { EmptyState } from "../../components/EmptyState";
import { colors, spacing, typeScale } from "../../design-tokens";

interface Member {
  userId: string;
  role: "OWNER" | "MEMBER";
  user: { name: string; email: string };
}

interface ProjectDetail {
  id: string;
  title: string;
  department: string | null;
  businessUnit: string | null;
  location: string | null;
  hiringManager: string | null;
  vacancies: number;
  employmentType: string | null;
  description: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: Member[];
}

const NEXT_STATUS: Record<string, string[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ON_HOLD", "READY_FOR_CV_UPLOAD", "ARCHIVED"],
  ON_HOLD: ["ACTIVE", "ARCHIVED"],
  READY_FOR_CV_UPLOAD: ["ON_HOLD", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

/**
 * UI Batch 3 — Project Overview as the operational landing page.
 *
 * Every number below is read as-is from existing endpoints
 * (GET /projects/:id, /projects/:id/requirements, /projects/:id/candidates,
 * /projects/:id/staged-uploads) — no new backend route, no invented status,
 * no computed percentage presented as a score. Two things this page
 * deliberately does NOT attempt, documented rather than faked:
 *
 *  1. Mandatory-gap / "needs HR review" detection at the project level would
 *     require fetching every candidate's own /assessments response (no
 *     existing aggregate endpoint returns this across a project) — an N+1
 *     fetch disproportionate to a summary page. Left out rather than
 *     approximated; the per-candidate detail page already surfaces this.
 *  2. A true cross-event Activity/Audit trail (requirement approvals, HR
 *     decisions, purges) needs the AuditLog-exposing endpoint already
 *     identified as separate, not-yet-authorized backend work (Batch 2's
 *     own audit). "Recent Activity" below is explicitly the one real,
 *     already-available proxy for it: each candidate document's own
 *     `uploadedAt`, sorted — labeled as uploads, never overstated as a full
 *     audit log.
 */

interface RequirementSummary {
  id: string;
  status: string;
  currentVersionNumber: number;
}

type DocumentStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED_RETRY" | "FAILED_NEEDS_OCR";
interface CandidateDocumentSummary {
  id: string;
  originalFilename: string;
  status: DocumentStatus;
  uploadedAt: string;
}
interface CandidateLinkSummary {
  candidateId: string;
  anonymizedLabel: string;
  documents: CandidateDocumentSummary[];
}

interface StagedUploadSummary {
  stagedUploadId: string;
  originalFilename: string;
  status: string;
  uploadedAt: string;
}

const MIN_COMPARE = 2;

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [requirements, setRequirements] = useState<RequirementSummary[] | null>(null);
  const [candidates, setCandidates] = useState<CandidateLinkSummary[] | null>(null);
  const [stagedUploads, setStagedUploads] = useState<StagedUploadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignEmail, setAssignEmail] = useState("");

  async function load() {
    try {
      const data = await apiFetch<ProjectDetail>(`/projects/${projectId}`);
      setProject(data);
      setError(null);
    } catch {
      setError("Project not found, or you don't have access to it.");
    }
    // Each independent — one endpoint being briefly unavailable must never
    // blank the whole Overview; every section below renders only once its
    // own data has arrived, and is simply omitted (never shown as "0" or
    // "failed") if its own fetch hasn't resolved yet or errors.
    apiFetch<RequirementSummary[]>(`/projects/${projectId}/requirements`).then(setRequirements).catch(() => {});
    apiFetch<CandidateLinkSummary[]>(`/projects/${projectId}/candidates`).then(setCandidates).catch(() => {});
    apiFetch<StagedUploadSummary[]>(`/projects/${projectId}/staged-uploads`).then(setStagedUploads).catch(() => {});
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function changeStatus(status: string) {
    try {
      await apiFetch(`/projects/${projectId}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      load();
    } catch {
      setError("Could not change status.");
    }
  }

  if (error) return <main style={{ maxWidth: 900 }}><p style={{ color: colors.danger700 }}>{error}</p></main>;
  if (!project) return <main style={{ maxWidth: 900 }}><p>Loading…</p></main>;

  // --- Requirements readiness (same predicate as RequirementGateBanner:
  // a live, non-archived requirement with no approved version at all) ---
  const totalRequirements = requirements?.length ?? null;
  const unapprovedRequirements = requirements?.filter((r) => r.currentVersionNumber === 0) ?? [];
  const approvedRequirements = requirements?.filter((r) => r.currentVersionNumber > 0) ?? [];
  const requirementsReady = requirements !== null && requirements.length > 0 && unapprovedRequirements.length === 0;

  // --- Candidate processing summary (document-level counts: identical
  // aggregation to the existing Candidates page's own `counts` reducer —
  // not a new state model) ---
  const allDocuments = candidates?.flatMap((c) => c.documents) ?? [];
  const uploadedCount = candidates?.length ?? null;
  const processingCount = allDocuments.filter((d) => d.status === "QUEUED" || d.status === "PROCESSING").length;
  const failedCount = allDocuments.filter((d) => d.status === "FAILED_RETRY" || d.status === "FAILED_NEEDS_OCR").length;
  const needsReviewCount = stagedUploads?.filter((s) => s.status === "PENDING_REVIEW").length ?? 0;

  // --- Comparison readiness: candidate-level, not document-level ---
  // Traced against the real POST /projects/:id/candidates/compare route
  // (apps/api/src/modules/assessments/routes.ts): its only actual gate is
  // 2-5 distinct candidateIds linked to the project — it has NO processing-
  // status requirement at all (a fully QUEUED candidate can be submitted;
  // the page then shows "Processing…"/"No results yet" for that column, as
  // already implemented there). So "Comparison available" here is
  // deliberately a STRICTER, disclosed product choice — "available AND
  // likely to show useful data" — not a claim about what the route
  // technically accepts.
  //
  // This must be counted per CANDIDATE, not per document: a candidate with
  // two documents where only one is COMPLETED is one ready candidate, not
  // counted twice. A candidate counts as ready here if it is not currently
  // processing and has at least one COMPLETED document — same precedence
  // (processing beats ready) already used on the Candidate Profile page.
  const readyCandidateIds =
    candidates?.filter((c) => {
      const isProcessing = c.documents.some((d) => d.status === "QUEUED" || d.status === "PROCESSING");
      const hasCompleted = c.documents.some((d) => d.status === "COMPLETED");
      return !isProcessing && hasCompleted;
    }).map((c) => c.candidateId) ?? [];
  const comparisonAvailable = readyCandidateIds.length >= MIN_COMPARE;

  // --- Readiness / Next Action (one primary state, in this precedence) ---
  type Readiness = { heading: string; body: string; action?: { href: string; label: string } };
  let readiness: Readiness;
  if (requirements === null) {
    readiness = { heading: "Checking requirements…", body: "" };
  } else if (!requirementsReady) {
    readiness = {
      heading: "Requirements not ready",
      body:
        totalRequirements === 0
          ? "This project has no requirements yet. Add and approve requirements before uploading CVs."
          : "One or more requirements still need HR approval. Candidate comparison and V1 Scoring are not available until every requirement is approved.",
      action: { href: `/projects/${projectId}/requirements`, label: "Go to Requirements" },
    };
  } else if (candidates === null) {
    readiness = { heading: "Checking candidates…", body: "" };
  } else if (uploadedCount === 0) {
    readiness = {
      heading: "Requirements ready — no CVs yet",
      body: "Requirements are approved. The next step is uploading candidate CVs for this project.",
      action: { href: `/projects/${projectId}/candidates`, label: "Go to Candidates" },
    };
  } else if (processingCount > 0) {
    readiness = {
      heading: "Candidates processing",
      body: `${processingCount} of ${allDocuments.length} uploaded document(s) are still being processed. This is normal — unprocessed candidates have not failed anything, they simply aren't ready to review yet.`,
      action: { href: `/projects/${projectId}/candidates`, label: "View processing status" },
    };
  } else if (comparisonAvailable) {
    readiness = {
      heading: "Comparison available",
      body: `${readyCandidateIds.length} candidate(s) are processed and ready. You can compare candidates side by side — this is a decision-support view, not a recommendation.`,
      action: { href: `/projects/${projectId}/candidates/compare`, label: "Go to Comparison" },
    };
  } else if (readyCandidateIds.length >= 1) {
    readiness = {
      heading: "Candidates ready for review",
      body: `${readyCandidateIds.length} candidate(s) are processed and ready to review. Select at least ${MIN_COMPARE} to use Comparison.`,
      action: { href: `/projects/${projectId}/candidates`, label: "Go to Candidates" },
    };
  } else {
    readiness = {
      heading: "No candidates ready yet",
      body: "No uploaded candidate has completed processing yet.",
      action: { href: `/projects/${projectId}/candidates`, label: "Go to Candidates" },
    };
  }

  // --- Recent uploads (real data: document uploadedAt, not a full audit trail) ---
  const recentUploads = [...allDocuments].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).slice(0, 5);

  return (
    <main style={{ maxWidth: 900 }}>
      {project.description && <p style={{ color: colors.ink600 }}>{project.description}</p>}

      {/* B. Readiness / Next Action */}
      <Card style={{ marginBottom: spacing.lg, borderLeft: `4px solid ${colors.brand700}` }}>
        <h2 style={{ ...typeScale.sectionTitle, marginTop: 0 }}>{readiness.heading}</h2>
        {readiness.body && <p style={{ color: colors.ink600, margin: "4px 0 0" }}>{readiness.body}</p>}
        {readiness.action && (
          <p style={{ marginBottom: 0 }}>
            <Link href={readiness.action.href} style={{ color: colors.brand700 }}>
              {readiness.action.label} →
            </Link>
          </p>
        )}
      </Card>

      {/* C. Project Metrics */}
      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", marginBottom: spacing.lg }}>
        <MetricCard label="Requirements" value={totalRequirements ?? "…"} />
        <MetricCard
          label="Approved"
          value={requirements ? `${approvedRequirements.length} / ${totalRequirements}` : "…"}
        />
        <MetricCard label="Candidates" value={uploadedCount ?? "…"} />
        <MetricCard label="Processing" value={candidates ? processingCount : "…"} />
        <MetricCard
          label="Comparison"
          value={candidates ? (comparisonAvailable ? "Available" : "Not yet") : "…"}
        />
      </div>

      {/* G. Warnings / Review Notices (distinct from the workspace-level
          requirement-approval banner already shown above this page — never
          repeating that same message here) */}
      {(failedCount > 0 || needsReviewCount > 0) && (
        <Card style={{ marginBottom: spacing.lg, background: colors.cautionBg, border: `1px solid ${colors.caution700}` }}>
          <h2 style={{ ...typeScale.sectionTitle, marginTop: 0, color: colors.caution700 }}>Needs HR attention</h2>
          <ul style={{ margin: "4px 0 0", paddingLeft: spacing.lg }}>
            {failedCount > 0 && (
              <li>
                {failedCount} document(s) failed processing and may need a retry — see Candidates.
              </li>
            )}
            {needsReviewCount > 0 && (
              <li>
                {needsReviewCount} upload(s) need administrator review for a possible duplicate candidate.
              </li>
            )}
          </ul>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.lg, marginBottom: spacing.lg }}>
        {/* E. Requirements Summary */}
        <Card>
          <h2 style={{ ...typeScale.sectionTitle, marginTop: 0 }}>Requirements</h2>
          {requirements === null ? (
            <p style={{ color: colors.ink600 }}>Loading…</p>
          ) : requirements.length === 0 ? (
            <EmptyState>No requirements yet.</EmptyState>
          ) : (
            <p style={{ color: colors.ink600 }}>
              {approvedRequirements.length} of {totalRequirements} approved.{" "}
              {requirementsReady
                ? "Ready for candidate processing."
                : `${unapprovedRequirements.length} still need HR approval.`}
            </p>
          )}
          <p style={{ marginBottom: 0 }}>
            <Link href={`/projects/${projectId}/requirements`} style={{ color: colors.brand700 }}>
              Open Requirements →
            </Link>
          </p>
        </Card>

        {/* F. Candidate Summary */}
        <Card>
          <h2 style={{ ...typeScale.sectionTitle, marginTop: 0 }}>Candidates</h2>
          {candidates === null ? (
            <p style={{ color: colors.ink600 }}>Loading…</p>
          ) : candidates.length === 0 ? (
            <EmptyState>No candidates uploaded yet.</EmptyState>
          ) : (
            <p style={{ color: colors.ink600 }}>
              {uploadedCount} uploaded · {readyCandidateIds.length} candidate(s) ready · {processingCount} document(s) processing
              {failedCount > 0 && ` · ${failedCount} failed`}.{" "}
              {comparisonAvailable
                ? "Comparison is available."
                : `At least ${MIN_COMPARE} ready candidates are needed for Comparison.`}
            </p>
          )}
          <p style={{ marginBottom: 0 }}>
            <Link href={`/projects/${projectId}/candidates`} style={{ color: colors.brand700 }}>
              Open Candidates →
            </Link>
          </p>
        </Card>
      </div>

      {/* H. Recent Activity (recent uploads — explicitly not a full audit trail) */}
      <Card style={{ marginBottom: spacing.lg }}>
        <h2 style={{ ...typeScale.sectionTitle, marginTop: 0 }}>Recent Uploads</h2>
        {recentUploads.length === 0 ? (
          <EmptyState>No document uploads yet.</EmptyState>
        ) : (
          <ul style={{ margin: 0, paddingLeft: spacing.lg }}>
            {recentUploads.map((d) => (
              <li key={d.id} style={{ fontSize: 13, color: colors.ink600 }}>
                {d.originalFilename} — {new Date(d.uploadedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Project metadata + status transitions + member assignment
          (unchanged from prior batches, kept below the operational summary) */}
      <h2 style={typeScale.sectionTitle}>Project Details</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", rowGap: 6 }}>
        <dt style={{ color: colors.ink600 }}>Department</dt>
        <dd>{project.department ?? "—"}</dd>
        <dt style={{ color: colors.ink600 }}>Business unit</dt>
        <dd>{project.businessUnit ?? "—"}</dd>
        <dt style={{ color: colors.ink600 }}>Location</dt>
        <dd>{project.location ?? "—"}</dd>
        <dt style={{ color: colors.ink600 }}>Hiring manager</dt>
        <dd>{project.hiringManager ?? "—"}</dd>
        <dt style={{ color: colors.ink600 }}>Vacancies</dt>
        <dd>{project.vacancies}</dd>
        <dt style={{ color: colors.ink600 }}>Employment type</dt>
        <dd>{project.employmentType ?? "—"}</dd>
        <dt style={{ color: colors.ink600 }}>Created</dt>
        <dd>{new Date(project.createdAt).toLocaleString()}</dd>
        <dt style={{ color: colors.ink600 }}>Last updated</dt>
        <dd>{new Date(project.updatedAt).toLocaleString()}</dd>
      </dl>

      <h2 style={typeScale.sectionTitle}>Status</h2>
      <div style={{ display: "flex", gap: spacing.sm }}>
        {(NEXT_STATUS[project.status] ?? []).map((s) => (
          <button key={s} onClick={() => changeStatus(s)}>
            Move to {s.replaceAll("_", " ")}
          </button>
        ))}
        {(NEXT_STATUS[project.status] ?? []).length === 0 && <span style={{ color: colors.ink600 }}>No further transitions.</span>}
      </div>

      <h2 style={typeScale.sectionTitle}>Assigned HR users</h2>
      <ul>
        {project.members.map((m) => (
          <li key={m.userId}>
            {m.user.name} ({m.user.email}) — {m.role}
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const users = await apiFetch<{ id: string; email: string }[]>(`/users?search=${encodeURIComponent(assignEmail)}`).catch(() => []);
            const match = users.find((u) => u.email === assignEmail);
            if (!match) {
              setError("No user found with that email. (User lookup endpoint is minimal in Phase 2 — enter the exact email.)");
              return;
            }
            await apiFetch(`/projects/${projectId}/members`, {
              method: "POST",
              body: JSON.stringify({ userId: match.id, role: "MEMBER" }),
            });
            setAssignEmail("");
            load();
          } catch {
            setError("Could not assign user.");
          }
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          placeholder="teammate@example.com"
          value={assignEmail}
          onChange={(e) => setAssignEmail(e.target.value)}
        />
        <button type="submit">Assign</button>
      </form>
    </main>
  );
}
