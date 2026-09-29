import { prisma, type Assessment } from "@recruitment-platform/db";

/**
 * Score Evidence Eligibility (ratified decision paper, Items 1-26 + Final
 * Synthesis). The exact, sole predicate — never extended here:
 *
 *   assessment.processingRunId === candidate.currentProfileProcessingRunId
 *
 * Deliberately does NOT check ProcessingRun.status, EvidenceStrength,
 * EvidenceConfidence, AssessmentStatus, AssessmentEvidence.role, HR
 * decisions, requirement version currency (Item 11, open), requirement
 * active/lifecycle state (Item 22, open), or AI provenance — all ruled
 * outside eligibility. Does not resolve cross-project scoping of
 * currentProfileProcessingRunId (Item 16, open); candidateId and projectId
 * are both required inputs rather than inferred.
 *
 * Read-consistency between the Candidate read and the Assessment read is
 * NOT addressed here — default Prisma/Postgres READ COMMITTED semantics do
 * not guarantee the two statements observe the same snapshot. That
 * strategy remains an explicitly deferred, separate decision.
 */
export async function resolveEligibleAssessments(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma,
  candidateId: string,
  projectId: string,
): Promise<Assessment[]> {
  const candidate = await tx.candidate.findUnique({
    where: { id: candidateId },
    select: { currentProfileProcessingRunId: true },
  });

  if (!candidate?.currentProfileProcessingRunId) return [];

  return tx.assessment.findMany({
    where: {
      candidateId,
      projectId,
      processingRunId: candidate.currentProfileProcessingRunId,
    },
  });
}
