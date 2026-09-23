import { prisma } from "@recruitment-platform/db";
import type { AIProvider, AiRunRequest, AiRunResult } from "@recruitment-platform/ai-gateway";

/** Deletes every row in dependency order — mirrors apps/api's test-utils. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.aiInteraction.deleteMany(),
    prisma.hrOverride.deleteMany(),
    prisma.hrDecision.deleteMany(),
    prisma.candidateComparison.deleteMany(),
    prisma.assessmentEvidence.deleteMany(),
    prisma.assessment.deleteMany(),
    prisma.evidence.deleteMany(),
    prisma.jobRequirementVersion.deleteMany(),
    prisma.requirementWeightApproval.deleteMany(),
    prisma.requirementSemanticConcept.deleteMany(),
    prisma.requirementEvidenceCriterion.deleteMany(),
    prisma.jobRequirement.deleteMany(),
    prisma.candidateDocument.deleteMany(),
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
    data: { email, name: email.split("@")[0], role: "HR_USER", passwordHash: "unused-in-worker-tests" },
  });
}

export async function seedAiModelConfig(taskType: string, provider = "fake"): Promise<void> {
  await prisma.aiModelConfiguration.upsert({
    where: { taskType: taskType as never },
    update: { provider, isActive: true },
    create: {
      taskType: taskType as never,
      provider,
      model: "fake-model",
      promptVersion: "test",
      isActive: true,
    },
  });
}

/**
 * A canned AIProvider for pipeline tests — no live Claude call. Unlike the
 * API's FakeAIProvider (which parses a JSON array userPrompt to echo back
 * real IDs), Resume Intelligence's userPrompt is raw resume text, so this
 * one just returns a fixed response per task type, or throws if configured
 * to simulate an invalid AI response.
 */
export class FakeAIProvider implements AIProvider {
  readonly name = "fake";
  constructor(private readonly responses: Record<string, unknown | (() => unknown)>) {}

  async run(request: AiRunRequest): Promise<AiRunResult> {
    const response = this.responses[request.taskType];
    if (response === undefined) {
      throw new Error(`FakeAIProvider has no canned response for ${request.taskType}`);
    }
    const value = typeof response === "function" ? (response as () => unknown)() : response;
    return { rawText: JSON.stringify(value) };
  }
}
