import type { ReactNode } from "react";
import Link from "next/link";
import { colors, spacing } from "../design-tokens";

/**
 * UI Batch 1 — foundation primitive only. Not yet wired into any page: the
 * Project Workspace restructuring (Overview/Requirements/Candidates/
 * Comparison/Decisions/Activity as tabs of one shell) is a later, separately
 * authorized batch. Built now so that batch can consume it directly.
 */
export interface TabItem {
  href: string;
  label: string;
  active?: boolean;
}

export function Tabs({ items }: { items: TabItem[] }) {
  return (
    <nav
      style={{
        display: "flex",
        gap: spacing.lg,
        flexWrap: "wrap",
        borderBottom: `1px solid ${colors.border}`,
        marginBottom: spacing.lg,
      }}
    >
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          style={{
            padding: `${spacing.sm}px 0`,
            fontSize: 14,
            fontWeight: item.active ? 600 : 400,
            color: item.active ? colors.brand700 : colors.ink600,
            borderBottom: item.active ? `2px solid ${colors.brand700}` : "2px solid transparent",
            textDecoration: "none",
          }}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
