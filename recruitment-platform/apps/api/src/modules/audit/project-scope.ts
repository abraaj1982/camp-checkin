import { prisma, Prisma } from "@recruitment-platform/db";

/**
 * Audit Read API — project-scoped query (approved design, revision 2).
 *
 * `AuditLog` has no `projectId` column (architecture doc: deliberately not
 * added without a proven need). Project association is resolved per
 * entity type, entirely inside one parameterized SQL statement:
 *
 *   - RecruitmentProject: entityId IS the projectId (direct).
 *   - JobRequirement: one join on its own projectId column.
 *   - JobRequirementVersion: two-hop join through its parent requirement.
 *   - StagedUpload / CandidateMatchReview: one join, each has its own
 *     non-nullable projectId column.
 *   - CandidateDocument: one join on its own projectId column — nullable
 *     in the schema, so a row with a null projectId is naturally excluded
 *     by the IN-subquery, never guessed at.
 *   - Candidate (non-purge actions): resolved via CandidateProjectLink,
 *     since Candidate itself has no projectId (candidates are legitimately
 *     many-to-project).
 *   - Candidate / CANDIDATE_PII_PURGED: resolved via a jsonb containment
 *     check against the event's own `afterJson.projectIdsCausingEligibility`
 *     array (packages/candidate-retention/src/candidate-purge.ts) — a purge
 *     can be caused by eligibility across several projects at once, so this
 *     is membership-tested, never assumed single-project.
 *
 * LOGIN/LOGOUT are excluded unconditionally — they have no project relation
 * at all (User-entityType, account-level events).
 *
 * Pagination, project scoping, and ordering (`createdAt DESC, id DESC`)
 * all happen inside this single query — nothing is loaded into Node and
 * filtered/paginated in application memory. `pageSize + 1` rows are
 * requested so the caller can compute `hasMore` without a second COUNT(*)
 * query; no exact total count is produced in this version.
 */

export interface AuditLogRow {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: Date;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface FetchProjectAuditLogOptions {
  page?: number;
  pageSize?: number;
}

export interface FetchProjectAuditLogResult {
  rows: AuditLogRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

function normalizePage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}

export async function fetchProjectAuditLog(
  projectId: string,
  options: FetchProjectAuditLogOptions = {},
): Promise<FetchProjectAuditLogResult> {
  const page = normalizePage(options.page);
  const pageSize = normalizePageSize(options.pageSize);
  const skip = (page - 1) * pageSize;

  const rows = await prisma.$queryRaw<AuditLogRow[]>(Prisma.sql`
    SELECT "id", "actorId", "action", "entityType", "entityId", "createdAt"
    FROM "AuditLog"
    WHERE "action" NOT IN ('LOGIN', 'LOGOUT')
      AND (
        ("entityType" = 'RecruitmentProject' AND "entityId" = ${projectId})

        OR ("entityType" = 'JobRequirement' AND "entityId" IN (
          SELECT "id" FROM "JobRequirement" WHERE "projectId" = ${projectId}
        ))

        OR ("entityType" = 'JobRequirementVersion' AND "entityId" IN (
          SELECT jrv."id" FROM "JobRequirementVersion" jrv
          JOIN "JobRequirement" jr ON jr."id" = jrv."requirementId"
          WHERE jr."projectId" = ${projectId}
        ))

        OR ("entityType" = 'StagedUpload' AND "entityId" IN (
          SELECT "id" FROM "StagedUpload" WHERE "projectId" = ${projectId}
        ))

        OR ("entityType" = 'CandidateMatchReview' AND "entityId" IN (
          SELECT "id" FROM "CandidateMatchReview" WHERE "projectId" = ${projectId}
        ))

        OR ("entityType" = 'CandidateDocument' AND "entityId" IN (
          SELECT "id" FROM "CandidateDocument" WHERE "projectId" = ${projectId}
        ))

        OR ("entityType" = 'Candidate' AND "action" != 'CANDIDATE_PII_PURGED' AND "entityId" IN (
          SELECT "candidateId" FROM "CandidateProjectLink" WHERE "projectId" = ${projectId}
        ))

        OR ("entityType" = 'Candidate' AND "action" = 'CANDIDATE_PII_PURGED'
            AND ("afterJson" -> 'projectIdsCausingEligibility') ? ${projectId})
      )
    ORDER BY "createdAt" DESC, "id" DESC
    LIMIT ${pageSize + 1} OFFSET ${skip}
  `);

  const hasMore = rows.length > pageSize;
  return {
    rows: hasMore ? rows.slice(0, pageSize) : rows,
    page,
    pageSize,
    hasMore,
  };
}
