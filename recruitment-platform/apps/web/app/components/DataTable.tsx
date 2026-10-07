import type { ReactNode } from "react";
import { colors, spacing } from "../design-tokens";

/**
 * UI Batch 1 — thin, styled table primitives, not a fully generic
 * data-driven <DataTable columns rows /> API. Each existing table-using
 * page (Projects, Requirements, Candidates, Comparison) has its own
 * distinct per-row logic (expandable rows, checkboxes, grouped sections) —
 * forcing them all through one generic columns/rows shape would be a
 * significant, risky rewrite of working logic for a visual-only batch.
 * This keeps each page's existing structure and logic untouched, swapping
 * only the raw <table>/<tr>/<td> tags for these token-styled equivalents.
 */

export function Table({ children }: { children: ReactNode }) {
  return <table style={{ width: "100%", borderCollapse: "collapse" }}>{children}</table>;
}

export function TableHeadRow({ children }: { children: ReactNode }) {
  return <tr style={{ textAlign: "left", borderBottom: `2px solid ${colors.borderStrong}` }}>{children}</tr>;
}

export function HeaderCell({ children }: { children?: ReactNode }) {
  return (
    <th style={{ padding: spacing.sm, fontSize: 13, fontWeight: 600, color: colors.ink600 }}>{children}</th>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return <tr style={{ borderBottom: `1px solid ${colors.border}`, ...style }}>{children}</tr>;
}

export function Cell({ children, style }: { children?: ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: spacing.sm, ...style }}>{children}</td>;
}
