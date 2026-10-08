import { colors, spacing } from "../design-tokens";

/**
 * UI Batch 1 — the fixed, non-negotiable "this is not a recommendation"
 * disclaimer text, componentized so Evidence Coverage's and V1 Score's
 * wording can never silently drift apart between the two call sites. Text
 * is unchanged from the existing compare page's COVERAGE_DISCLAIMER/
 * SCORE_DISCLAIMER constants.
 */
export const COVERAGE_DISCLAIMER_TEXT =
  "Evidence Coverage reflects weighted evidence against approved requirements — not a suitability, quality, or hiring recommendation.";
export const SCORE_DISCLAIMER_TEXT =
  "V1 Score reflects weighted evaluation state against approved, pinned requirement weights — not a suitability, quality, or hiring recommendation.";
export const DECISION_INDEPENDENCE_TEXT =
  "This decision is made by HR and does not use V1 Score or Evidence Coverage as an input.";
export const DECISION_GOVERNANCE_NOTE_TEXT =
  "This records an HR decision based on the available review information.";

export function Disclaimer({ text }: { text: string }) {
  return (
    <p style={{ fontSize: 12, color: colors.ink400, marginTop: -spacing.sm, marginBottom: spacing.lg }}>{text}</p>
  );
}
