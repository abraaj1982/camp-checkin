import type { ReactNode } from "react";
import { colors, radii, spacing } from "../design-tokens";

export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        padding: spacing.lg,
        background: colors.surface,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
