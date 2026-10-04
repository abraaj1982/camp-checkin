import { prisma, type Assessment } from "@recruitment-platform/db";

/**
 * Score Evidence Eligibility (ratified decision paper, Items 1-26 + Final
 * Synthesis; Item 16 resolved via Option B — CandidateProjectAuthority).
 * The exact, sole predicate — never extended here:
 *
 *   assessment.processingRunId === CandidateProjectAuthority.currentProcessingRunId
 *   for the Assessment's own (candidateId, projectId)
 *
 * Deliberately does NOT check ProcessingRun.status, EvidenceStrength,
 * EvidenceConfidence, AssessmentStatus, AssessmentEvidence.role, HR
 * decisions, requirement version currency (Item 11, outside eligibility),
 * requirement active/lifecycle state (Item 22, outside eligibility), or AI
 * provenance — all ruled outside eligibility.
 *
 * Candidate.currentProfileProcessingRunId (Phase 11) is NOT used here — it
 * remains exclusively the candidate-wide consolidated profile authority
 * (CandidateExperience/Education/Skill/Certification/Language), a separate
 * concern from this project-scoped Assessment/Evidence authority.
 *
 * Read-consistency between the CandidateProjectAuthority read and the
 * Assessment read is NOT addressed here — default Prisma/Postgres READ
 * COMMITTED semantics do not guarantee the two statements observe the same
 * snapshot. That strategy remains an explicitly deferred, separate
 * decision (Item 17).
 */
export async function resolveEligibleAssessments(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma,
  candidateId: string,
  projectId: string,
): Promise<Assessment[]> {
  const authority = await tx.candidateProjectAuthority.findUnique({
    where: { candidateId_projectId: { candidateId, projectId } },
    select: { currentProcessingRunId: true },
  });

  if (!authority?.currentProcessingRunId) return [];

  return tx.assessment.findMany({
    where: {
      candidateId,
      projectId,
      processingRunId: authority.currentProcessingRunId,
    },
  });
}
