import { colors, radii, spacing } from "../design-tokens";

export interface EvidenceCardItem {
  role?: "SUPPORTING" | "CONSIDERED_REJECTED";
  rationale: string | null;
  evidenceStrength: string;
  confidence: string;
  evidenceType: string;
  sourcePage: number | null;
  evidenceText: string | null;
  source: string | null;
}

function sourceLabel(source: string | null, sourcePage: number | null): string {
  if (!source) return "No source";
  return sourcePage !== null ? `${source}, page ${sourcePage}` : source;
}

/**
 * UI Batch 1 — shared evidence item card, unifying the two previously
 * duplicated inline implementations (Candidate Profile and Candidate
 * Comparison). The two pages show evidence in different contexts —
 * Candidate Profile already groups evidence into separate "Supporting"/
 * "Considered Rejected" sections (so its own card never needs to repeat the
 * role), while Comparison shows role/evidence inline per candidate — so
 * `showRole` preserves each page's EXACT existing text output rather than
 * forcing one page's format onto the other.
 */
export function EvidenceCard({ item, showRole = false }: { item: EvidenceCardItem; showRole?: boolean }) {
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: radii.sm,
        padding: spacing.md,
        marginTop: spacing.sm,
        marginBottom: spacing.sm,
      }}
    >
      <p style={{ margin: 0, fontSize: 13, color: colors.ink600 }}>
        {showRole ? (
          <>
            {item.role?.replaceAll("_", " ")} · {item.evidenceStrength} · {item.confidence}
          </>
        ) : (
          <>
            Strength: <strong>{item.evidenceStrength}</strong> · Confidence: <strong>{item.confidence}</strong> · Type:{" "}
            {item.evidenceType}
          </>
        )}
      </p>
      {item.evidenceText && <p style={{ margin: "8px 0" }}>&ldquo;{item.evidenceText}&rdquo;</p>}
      {item.rationale && <p style={{ margin: "8px 0", color: colors.ink600 }}>{item.rationale}</p>}
      <p style={{ margin: 0, fontSize: 12, color: colors.ink400 }}>{sourceLabel(item.source, item.sourcePage)}</p>
    </div>
  );
}
