import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { AIProvider, AiRunRequest, AiRunResult } from "@recruitment-platform/ai-gateway";
import { EmailPasswordStrategy } from "../modules/auth/email-password-strategy.js";

/** Deletes every row in dependency order — cheap and safe between tests. */
export async function resetDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.aiInteraction.deleteMany(),
    prisma.hrOverride.deleteMany(),
    prisma.hrDecision.deleteMany(),
    prisma.candidateComparison.deleteMany(),
    prisma.evidence.deleteMany(),
    prisma.assessment.deleteMany(),
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

export async function createUser(
  email: string,
  role: "HR_USER" | "HR_ADMIN" | "SYSTEM_ADMIN",
  password = "test-password-123",
) {
  return prisma.user.create({
    data: {
      email,
      name: email.split("@")[0],
      role,
      passwordHash: await EmailPasswordStrategy.hashPassword(password),
    },
  });
}

/** Logs in via the real /auth/login route and returns the session cookie header. */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password = "test-password-123",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error(`Login failed for ${email}: ${res.statusCode} ${res.body}`);
  return raw.split(";")[0];
}

/**
 * A canned AIProvider for tests — no real Claude/network call, per Phase 2
 * Section 14. Builders receive the real requirement IDs from the request's
 * userPrompt (the route always sends `{ requirementId | id, ... }[]` JSON)
 * so the fake response references IDs that actually exist in the test DB,
 * the way a real provider's response would.
 */
export class FakeAIProvider implements AIProvider {
  readonly name = "fake";
  constructor(
    private readonly builders: Record<string, (requirementIds: string[]) => unknown>,
  ) {}

  async run(request: AiRunRequest): Promise<AiRunResult> {
    const builder = this.builders[request.taskType];
    if (!builder) {
      throw new Error(`FakeAIProvider has no canned response for ${request.taskType}`);
    }
    const items = JSON.parse(request.userPrompt) as { id?: string; requirementId?: string }[];
    const requirementIds = items.map((item) => item.id ?? item.requirementId ?? "");
    return { rawText: JSON.stringify(builder(requirementIds)) };
  }
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
