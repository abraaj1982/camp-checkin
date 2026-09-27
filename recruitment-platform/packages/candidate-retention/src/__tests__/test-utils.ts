import { prisma } from "@recruitment-platform/db";

/** Deletes every row in dependency order — mirrors apps/api's and worker's test-utils. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.aiInteraction.deleteMany(),
    prisma.hrOverride.deleteMany(),
    prisma.hrDecision.deleteMany(),
    prisma.candidateComparison.deleteMany(),
    prisma.candidateMatchReview.deleteMany(),
    prisma.stagedUpload.deleteMany(),
    prisma.candidateConsistencyFinding.deleteMany(),
    prisma.assessmentEvidence.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.processingRun.deleteMany(),
    prisma.evidence.deleteMany(),
    prisma.candidateBatchRequirementVersion.deleteMany(),
    prisma.jobRequirementVersion.deleteMany(),
    prisma.requirementWeightApproval.deleteMany(),
    prisma.requirementSemanticConcept.deleteMany(),
    prisma.requirementEvidenceCriterion.deleteMany(),
    prisma.jobRequirement.deleteMany(),
    prisma.candidateDocument.deleteMany(),
    prisma.candidateUploadBatch.deleteMany(),
    prisma.candidateExperience.deleteMany(),
    prisma.candidateEducation.deleteMany(),
    prisma.candidateSkill.deleteMany(),
    prisma.candidateCertification.deleteMany(),
    prisma.candidateLanguage.deleteMany(),
    prisma.candidateProjectLink.deleteMany(),
    prisma.candidate.deleteMany(),
    prisma.projectMember.deleteMany(),
    prisma.recruitmentProject.deleteMany(),
    prisma.aiModelConfiguration.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

export async function createUser(email: string) {
  return prisma.user.create({
    data: { email, name: email.split("@")[0], role: "HR_USER", passwordHash: "unused-in-tests" },
  });
}
