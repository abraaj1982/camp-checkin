"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch, ApiError } from "../../../lib/api";
import { Card } from "../../components/Card";
import { colors, spacing, typeScale } from "../../design-tokens";

interface CandidateMatch {
  candidateId: string;
  candidateName: string;
}

interface MatchReview {
  reviewId: string;
  projectId: string;
  projectTitle: string;
  stagedUploadFilename: string;
  matchSignal: "EMAIL" | "PHONE" | "BOTH" | "CONFLICT";
  status: string;
  createdAt: string;
  emailMatch: CandidateMatch | null;
  phoneMatch: CandidateMatch | null;
}

/**
 * Admin-only resolution of ambiguous candidate-identity matches found
 * during upload (Phase 7). Mirrors the API's own data-minimization
 * boundary — never requests or displays a raw/normalized email or phone
 * value, only the categorical matchSignal and matched candidates' names.
 * The two resolution outcomes (LINK_EXISTING/CREATE_NEW) and their payload
 * shapes are exactly what POST /admin/candidate-match-reviews/:id/resolve
 * accepts — nothing invented here.
 */
export default function CandidateMatchReviewsPage() {
  const [reviews, setReviews] = useState<MatchReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ reviewId: string; outcome: "LINK_EXISTING" | "CREATE_NEW"; candidateId?: string; label: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function load() {
    setError(null);
    setForbidden(false);
    try {
      const data = await apiFetch<MatchReview[]>("/admin/candidate-match-reviews?status=PENDING");
      setReviews(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
      } else {
        setError("Could not load candidate match reviews.");
      }
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function resolve(reviewId: string, outcome: "LINK_EXISTING" | "CREATE_NEW", candidateId?: string) {
    setActionError(null);
    setResolvingId(reviewId);
    try {
      await apiFetch(`/admin/candidate-match-reviews/${reviewId}/resolve`, {
        method: "POST",
        body: JSON.stringify(candidateId ? { outcome, candidateId } : { outcome }),
      });
      setConfirming(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setActionError("This review was already resolved (possibly by someone else). Refreshing the list.");
        await load();
      } else if (e instanceof ApiError && e.status === 400) {
        setActionError("Invalid resolution — the selected candidate is not one of this review's matches.");
      } else if (e instanceof ApiError && e.status === 403) {
        setActionError("You don't have permission to resolve candidate match reviews.");
      } else {
        setActionError("Could not resolve this review.");
      }
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <main style={{ padding: spacing.xxl, maxWidth: 720, fontFamily: "system-ui, sans-serif" }}>
      <p>
        <Link href="/projects" style={{ color: colors.brand700 }}>
          ← Recruitment Projects
        </Link>
      </p>
      <h1 style={typeScale.pageTitle}>Candidate Match Reviews</h1>
      <p style={typeScale.meta}>
        Resolve candidates whose email/phone matched more than one existing record during upload. Requires HR_ADMIN or
        SYSTEM_ADMIN.
      </p>

      {forbidden && (
        <Card style={{ marginTop: spacing.lg }}>
          <p style={{ color: colors.danger700 }}>You don&apos;t have permission to view candidate match reviews.</p>
        </Card>
      )}

      {error && <p style={{ color: colors.danger700, marginTop: spacing.lg }}>{error}</p>}
      {actionError && <p style={{ color: colors.danger700, marginTop: spacing.lg }}>{actionError}</p>}

      {!forbidden && !error && reviews === null && <p style={{ marginTop: spacing.lg }}>Loading…</p>}

      {!forbidden && !error && reviews !== null && reviews.length === 0 && (
        <Card style={{ marginTop: spacing.lg }}>
          <p style={typeScale.meta}>No pending candidate match reviews.</p>
        </Card>
      )}

      {reviews && reviews.length > 0 && (
        <div style={{ marginTop: spacing.lg, display: "grid", gap: spacing.lg }}>
          {reviews.map((review) => (
            <Card key={review.reviewId}>
              <p style={typeScale.cardTitle}>{review.stagedUploadFilename}</p>
              <p style={typeScale.meta}>
                Project: {review.projectTitle} · Match signal: <strong>{review.matchSignal}</strong> · Submitted{" "}
                {new Date(review.createdAt).toLocaleString()}
              </p>

              <div style={{ marginTop: spacing.sm, display: "grid", gap: 4 }}>
                {review.emailMatch && (
                  <p style={typeScale.body}>
                    Email match: <strong>{review.emailMatch.candidateName}</strong>
                  </p>
                )}
                {review.phoneMatch && (
                  <p style={typeScale.body}>
                    Phone match: <strong>{review.phoneMatch.candidateName}</strong>
                  </p>
                )}
                {!review.emailMatch && !review.phoneMatch && <p style={typeScale.meta}>No candidate match details available.</p>}
              </div>

              <div style={{ marginTop: spacing.md, display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
                {review.emailMatch && (
                  <button
                    disabled={resolvingId === review.reviewId}
                    onClick={() =>
                      setConfirming({
                        reviewId: review.reviewId,
                        outcome: "LINK_EXISTING",
                        candidateId: review.emailMatch!.candidateId,
                        label: `Link to ${review.emailMatch!.candidateName} (email match)`,
                      })
                    }
                  >
                    Link to {review.emailMatch.candidateName}
                  </button>
                )}
                {review.phoneMatch && review.phoneMatch.candidateId !== review.emailMatch?.candidateId && (
                  <button
                    disabled={resolvingId === review.reviewId}
                    onClick={() =>
                      setConfirming({
                        reviewId: review.reviewId,
                        outcome: "LINK_EXISTING",
                        candidateId: review.phoneMatch!.candidateId,
                        label: `Link to ${review.phoneMatch!.candidateName} (phone match)`,
                      })
                    }
                  >
                    Link to {review.phoneMatch.candidateName}
                  </button>
                )}
                <button
                  disabled={resolvingId === review.reviewId}
                  onClick={() =>
                    setConfirming({
                      reviewId: review.reviewId,
                      outcome: "CREATE_NEW",
                      label: "Create a new candidate record",
                    })
                  }
                >
                  Create new candidate
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {confirming && (
        <div
          role="dialog"
          aria-label="Confirm resolution"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Card style={{ maxWidth: 420, background: colors.surface }}>
            <p style={typeScale.cardTitle}>Confirm this action</p>
            <p style={{ ...typeScale.body, marginTop: spacing.sm }}>{confirming.label}. This cannot be undone.</p>
            <div style={{ marginTop: spacing.lg, display: "flex", gap: spacing.sm, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirming(null)}>Cancel</button>
              <button
                disabled={resolvingId === confirming.reviewId}
                onClick={() => resolve(confirming.reviewId, confirming.outcome, confirming.candidateId)}
              >
                {resolvingId === confirming.reviewId ? "Resolving…" : "Confirm"}
              </button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}
