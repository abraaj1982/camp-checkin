import type { ReactNode } from "react";
import { colors } from "../design-tokens";

/** UI Batch 1 — always role="status" (announced to assistive tech) — processing/queued is transient, in-flight state, never a silent one. */
export function ProcessingState({ children }: { children: ReactNode }) {
  return (
    <p role="status" style={{ color: colors.caution700 }}>
      {children}
    </p>
  );
}
