/**
 * UI Batch 1 — Design Foundation. Plain exported constants, not CSS
 * variables or a runtime theme provider: matches the app's existing
 * inline-style convention (no CSS framework, no styling dependency added)
 * and keeps every page's visual values centralized and named instead of
 * repeated hex literals. Pure visual values only — nothing here encodes or
 * changes any business/API/scoring behavior.
 */

export const colors = {
  ink900: "#1a1f2b",
  ink600: "#555555",
  ink400: "#888888",
  border: "#e2e4e9",
  borderStrong: "#d7dae2",
  surface: "#ffffff",
  surfaceSubtle: "#f7f8fa",
  brand700: "#1f4e8c",
  success700: "#276749",
  successBg: "#eaf5ef",
  caution700: "#8a5a00",
  cautionBg: "#fdf3e2",
  danger700: "#9b2c2c",
  dangerBg: "#fbebeb",
  neutralBadgeBg: "#eceef2",
  neutralBadgeText: "#333333",
  focusRing: "#1f4e8c",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
} as const;

export const typeScale = {
  pageTitle: { fontSize: 24, fontWeight: 600, color: colors.ink900 },
  sectionTitle: { fontSize: 18, fontWeight: 600, color: colors.ink900 },
  cardTitle: { fontSize: 15, fontWeight: 600, color: colors.ink900 },
  body: { fontSize: 14, color: colors.ink900 },
  meta: { fontSize: 13, color: colors.ink600 },
  tiny: { fontSize: 12, color: colors.ink400 },
} as const;

/** Applied via onFocus/onBlur (no :focus-visible pseudo-class available from inline styles) — see FOCUSABLE_PROPS below for the common wiring. */
export const focusRingStyle = {
  outline: `2px solid ${colors.focusRing}`,
  outlineOffset: 2,
} as const;

export type BadgeVariant = "neutral" | "success" | "caution" | "danger" | "brand";

export const badgeVariantStyle: Record<BadgeVariant, { background: string; color: string }> = {
  neutral: { background: colors.neutralBadgeBg, color: colors.neutralBadgeText },
  success: { background: colors.successBg, color: colors.success700 },
  caution: { background: colors.cautionBg, color: colors.caution700 },
  danger: { background: colors.dangerBg, color: colors.danger700 },
  brand: { background: "#e8f0fb", color: colors.brand700 },
};
