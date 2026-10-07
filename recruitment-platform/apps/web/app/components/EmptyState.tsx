import type { ReactNode } from "react";
import { colors } from "../design-tokens";

/** UI Batch 1 — generic "nothing here yet" message. No role by default; pass role="status" for a state that existing tests/screen-reader behavior expect to be announced (see ProcessingState/FailedState for the two states that always are one). */
export function EmptyState({ children, role }: { children: ReactNode; role?: string }) {
  return (
    <p role={role} style={{ fontSize: 13, color: colors.ink400 }}>
      {children}
    </p>
  );
}
