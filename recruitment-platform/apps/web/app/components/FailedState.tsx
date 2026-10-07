import type { ReactNode } from "react";
import { colors } from "../design-tokens";

/** UI Batch 1 — always role="status" (announced to assistive tech) — a processing failure must be visible, never silently hidden. */
export function FailedState({ children }: { children: ReactNode }) {
  return (
    <p role="status" style={{ color: colors.danger700 }}>
      {children}
    </p>
  );
}
