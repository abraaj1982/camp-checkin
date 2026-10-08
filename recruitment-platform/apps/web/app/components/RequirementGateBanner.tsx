"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { colors, radii, spacing } from "../design-tokens";

/**
 * UI Batch 2a — one banner per Project Workspace (rendered once in the
 * shared layout, never repeated per tab). Surfaces exactly the real
 * scoring-blocking condition (`LIVE_REQUIREMENT_NOT_YET_APPROVED`): a live,
 * non-archived requirement that has never had an approved version
 * (`currentVersionNumber === 0`). This intentionally does NOT trigger on a
 * requirement mid-re-approval after an edit (status CHANGED/HR_REVIEW with
 * `currentVersionNumber > 0`) — that requirement still has a valid, pinned
 * approved version and does not block scoring, so flagging it here would
 * misstate what's actually blocked.
 *
 * Wording is deliberately scoped to what is true and nothing more:
 *  - never "ineligible", "rejected", or "failed" — only "not yet approved";
 *  - explicitly says this blocks the SCORE CALCULATION, not the candidate;
 *  - explicitly says it is not a hiring/eligibility signal.
 * Amber (existing `caution` design-system variant) — never red/danger
 * (nothing has failed) and never a gold/recommendation treatment.
 */

interface RequirementSummary {
  id: string;
  description: string;
  currentVersionNumber: number;
}

export function RequirementGateBanner({ projectId }: { projectId: string }) {
  const [unapproved, setUnapproved] = useState<RequirementSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<RequirementSummary[]>(`/projects/${projectId}/requirements`)
      .then((requirements) => {
        if (cancelled) return;
        setUnapproved(requirements.filter((r) => r.currentVersionNumber === 0));
      })
      .catch(() => {
        if (!cancelled) setUnapproved(null); // fails silently — informational only, never blocks the page
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!unapproved || unapproved.length === 0) return null;

  return (
    <div
      role="status"
      style={{
        background: colors.cautionBg,
        color: colors.caution700,
        border: `1px solid ${colors.caution700}`,
        borderRadius: radii.sm,
        padding: `${spacing.sm}px ${spacing.md}px`,
        marginTop: spacing.md,
        marginBottom: spacing.md,
        fontSize: 13,
      }}
    >
      {unapproved.length === 1 ? "1 requirement" : `${unapproved.length} requirements`} in this project{" "}
      {unapproved.length === 1 ? "has" : "have"} not yet been approved by HR. Until{" "}
      {unapproved.length === 1 ? "it is" : "they are"} approved, the V1 Score calculation cannot run for any
      candidate in this project — this does not mean any candidate has failed a requirement, and it is not a
      ranking, rejection, or hiring decision.
    </div>
  );
}
