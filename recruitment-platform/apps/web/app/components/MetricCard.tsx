import { Card } from "./Card";
import { colors, typeScale } from "../design-tokens";

/**
 * UI Batch 3 — restrained metric tile for the Project Overview. Deliberately
 * no percentage/health-score rendering built in: callers pass a plain
 * value/caption, never a computed ratio presented as a score (Evidence
 * Coverage and V1 Score each already have their own dedicated, disclaimed
 * display — this is not a third one).
 */
export function MetricCard({ label, value, caption }: { label: string; value: string | number; caption?: string }) {
  return (
    <Card style={{ minWidth: 150, flex: "1 1 150px" }}>
      <div style={typeScale.meta}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, color: colors.ink900, marginTop: 4 }}>{value}</div>
      {caption && <div style={typeScale.tiny}>{caption}</div>}
    </Card>
  );
}
