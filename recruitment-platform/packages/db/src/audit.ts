import { prisma } from "./index.js";

interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/**
 * The single write path to audit_logs (architecture doc, Section: Audit
 * Architecture). Shared by the API (HR-actor-driven actions) and the worker
 * (system-driven actions, actorId: null) so both write the same shape
 * rather than each having their own audit-insert logic.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      beforeJson: entry.before === undefined ? undefined : (entry.before as never),
      afterJson: entry.after === undefined ? undefined : (entry.after as never),
    },
  });
}
