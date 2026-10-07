// UI Batch 1 — moved to app/components/StatusBadge.tsx (shared design-system
// primitive). Re-exported here so every existing import path
// ("./status-badge" / "../status-badge" / "../../../status-badge") keeps
// working unchanged — no call site needed to move.
export { StatusBadge } from "../components/StatusBadge";
