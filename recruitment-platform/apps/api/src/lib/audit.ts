import { prisma } from "@recruitment-platform/db";

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
 * Architecture). Every module calls this instead of inserting rows itself,
 * so the log shape stays consistent and no module can accidentally skip
 * logging a material action. The application DB role has INSERT-only grant
 * on this table in non-dev environments — see infra/db-roles.sql.
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
