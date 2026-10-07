import { badgeVariantStyle, radii, type BadgeVariant } from "../design-tokens";

/**
 * UI Batch 1 — generalized from the original app/projects/status-badge.tsx
 * (now a re-export of this component so every existing import keeps
 * working unchanged). Rendered text is unchanged — still exactly
 * `status.replaceAll("_", " ")` — only the visual variant is new, derived
 * from well-known status values across the app. An unrecognized status
 * falls back to the original neutral gray badge, never throws.
 */
const VARIANT_BY_STATUS: Record<string, BadgeVariant> = {
  // RecruitmentProject.status
  DRAFT: "neutral",
  ACTIVE: "brand",
  ON_HOLD: "caution",
  READY_FOR_CV_UPLOAD: "brand",
  COMPLETED: "success",
  ARCHIVED: "neutral",
  // Assessment.status
  STRONG_EVIDENCE: "success",
  REVIEW_REQUIRED: "caution",
  MANDATORY_GAP: "danger",
  INSUFFICIENT_EVIDENCE: "neutral",
  // JobRequirement.status — an unapproved requirement must read as visually
  // distinct (never "basically the same, just a different label") from
  // APPROVED, per the design brief's "clear distinction between approved
  // and unapproved requirements."
  AI_ANALYZED: "neutral",
  HR_REVIEW: "caution",
  APPROVED: "success",
  CHANGED: "caution",
};

export function StatusBadge({ status }: { status: string }) {
  const variant = VARIANT_BY_STATUS[status] ?? "neutral";
  const { background, color } = badgeVariantStyle[variant];
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: radii.sm,
        fontSize: 12,
        fontWeight: 600,
        background,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}
