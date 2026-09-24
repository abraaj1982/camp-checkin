import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { runCareerConsistencyAnalysis } from "../career-consistency-analysis.js";
import { startProcessingRun } from "../processing-run.js";
import { FakeAIProvider, createUser, resetDatabase, seedAiModelConfig } from "./test-utils.js";

/**
 * Career/Consistency Analysis. Calls the function directly (not the full
 * pipeline) so each scenario controls the canned AI response precisely. No
 * live Claude call anywhere — FakeAIProvider only.
 */
describe("runCareerConsistencyAnalysis", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedCandidateWithDocument(projectTitle = "HR Manager") {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({ data: { title: projectTitle, createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "Jordan Doe" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
        status: "PROCESSING",
      },
    });
    await prisma.candidateExperience.createMany({
      data: [
        {
          candidateId: candidate.id,
          documentId: document.id,
          employer: "Acme Corp",
          title: "HR Officer",
          startDate: new Date("2019-01-01"),
          endDate: new Date("2021-06-01"),
          isCurrent: false,
        },
        {
          candidateId: candidate.id,
          documentId: document.id,
          employer: "Beta Inc",
          title: "HR Supervisor",
          startDate: new Date("2022-01-01"),
          endDate: null,
          isCurrent: true,
        },
      ],
    });
    return { user, project, candidate, document };
  }

  const jobData = (candidateId: string, projectId: string, documentId: string) => ({
    candidateDocumentId: documentId,
    candidateId,
    projectId,
  });

  it("persists multiple findings of different types and severities from one AI call", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Steady HR career progression with one gap.",
          findings: [
            {
              findingType: "EMPLOYMENT_GAP",
              severity: "INFORMATION_UNCLEAR",
              description: "Approximately 7-month gap between Acme Corp and Beta Inc.",
              sourcePage: null,
              evidenceText: null,
              confidence: "MEDIUM",
            },
            {
              findingType: "UNCLEAR_CHRONOLOGY",
              severity: "VERIFICATION_REQUIRED",
              description: "Two roles listed with ambiguous end dates.",
              sourcePage: 1,
              evidenceText: "HR Officer, Acme Corp (2019-2021)",
              confidence: "LOW",
            },
          ],
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id);

    const findings = await prisma.candidateConsistencyFinding.findMany({ where: { candidateId: candidate.id } });
    expect(findings).toHaveLength(2);
    const byType = new Map(findings.map((f) => [f.findingType, f]));
    expect(byType.get("EMPLOYMENT_GAP")?.severity).toBe("INFORMATION_UNCLEAR");
    expect(byType.get("UNCLEAR_CHRONOLOGY")?.severity).toBe("VERIFICATION_REQUIRED");
    // One ProcessingRun can hold multiple findings — no uniqueness
    // constraint on (processingRunId, findingType) or similar prevents it.
    expect(findings.every((f) => f.processingRunId === run.id)).toBe(true);
  });

  it("always sets sourceDocumentId from the application/document, never from the AI (the AI schema has no such field)", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [
            {
              findingType: "OTHER",
              severity: "POTENTIAL_INCONSISTENCY",
              description: "Something worth a look.",
              sourcePage: 2,
              evidenceText: "Some quote.",
              confidence: "HIGH",
            },
          ],
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id);

    const finding = await prisma.candidateConsistencyFinding.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(finding.sourceDocumentId).toBe(document.id);
    expect(finding.sourcePage).toBe(2);
    expect(finding.evidenceText).toBe("Some quote.");
  });

  it("allows sourcePage=null and evidenceText=null together for a date-math-only finding", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [
            {
              findingType: "EMPLOYMENT_GAP",
              severity: "INFORMATION_UNCLEAR",
              description: "Gap derived purely from comparing dates.",
              sourcePage: null,
              evidenceText: null,
              confidence: "MEDIUM",
            },
          ],
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id);

    const finding = await prisma.candidateConsistencyFinding.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(finding.sourcePage).toBeNull();
    expect(finding.evidenceText).toBeNull();
  });

  it("associates aiInteractionId with the AiInteraction row the gateway actually wrote", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [
            {
              findingType: "OTHER",
              severity: "POTENTIAL_INCONSISTENCY",
              description: "Finding.",
              sourcePage: null,
              evidenceText: null,
              confidence: "LOW",
            },
          ],
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id);

    const finding = await prisma.candidateConsistencyFinding.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(finding.aiInteractionId).not.toBeNull();
    const interaction = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: finding.aiInteractionId! } });
    expect(interaction.taskType).toBe("CAREER_CONSISTENCY_ANALYSIS");
    expect(interaction.inputRef).toBe(`candidateDocument:${document.id}:consistency`);
  });

  it("does not persist progressionNarrative anywhere (explicit deferred decision)", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "This exact narrative text must never be persisted anywhere.",
          findings: [],
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id);

    // No findings when the AI reports none — an empty array is a legitimate
    // "nothing worth flagging" result, not an error.
    const findings = await prisma.candidateConsistencyFinding.findMany({ where: { candidateId: candidate.id } });
    expect(findings).toHaveLength(0);
    // CandidateConsistencyFinding has no column that could hold this text at
    // all (by design) — there is nowhere in the schema it could have leaked to.
  });

  it("invalid AI output throws AiValidationError and persists zero findings", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [{ findingType: "NOT_A_REAL_TYPE", severity: "INFORMATION_UNCLEAR" }], // violates schema
        }),
      }),
    });

    const run = await startProcessingRun(document.id);
    await expect(
      runCareerConsistencyAnalysis(document, jobData(candidate.id, project.id, document.id), "resume text", gateway, run.id),
    ).rejects.toBeInstanceOf(AiValidationError);

    expect(await prisma.candidateConsistencyFinding.count({ where: { candidateId: candidate.id } })).toBe(0);
  });

  it("a retry (second call) produces another set of findings without deleting the first run's findings", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const { candidate, project, document } = await seedCandidateWithDocument();
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [
            {
              findingType: "EMPLOYMENT_GAP",
              severity: "INFORMATION_UNCLEAR",
              description: "Gap finding.",
              sourcePage: null,
              evidenceText: null,
              confidence: "MEDIUM",
            },
          ],
        }),
      }),
    });

    const data = jobData(candidate.id, project.id, document.id);
    const run1 = await startProcessingRun(document.id);
    await runCareerConsistencyAnalysis(document, data, "resume text", gateway, run1.id);
    await prisma.processingRun.update({ where: { id: run1.id }, data: { status: "COMPLETED", completedAt: new Date() } });

    const run2 = await startProcessingRun(document.id); // simulated retry
    await runCareerConsistencyAnalysis(document, data, "resume text", gateway, run2.id);

    const findings = await prisma.candidateConsistencyFinding.findMany({ where: { candidateId: candidate.id } });
    expect(findings).toHaveLength(2); // both runs' findings coexist — none deleted
    expect(new Set(findings.map((f) => f.processingRunId))).toEqual(new Set([run1.id, run2.id]));
  });

  it("keeps findings isolated between two different candidates/projects", async () => {
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const seedA = await seedCandidateWithDocument("Project A");
    const seedB = await seedCandidateWithDocument("Project B");
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        CAREER_CONSISTENCY_ANALYSIS: () => ({
          progressionNarrative: "Narrative.",
          findings: [
            {
              findingType: "OTHER",
              severity: "POTENTIAL_INCONSISTENCY",
              description: "Finding.",
              sourcePage: null,
              evidenceText: null,
              confidence: "LOW",
            },
          ],
        }),
      }),
    });

    const runA = await startProcessingRun(seedA.document.id);
    const runB = await startProcessingRun(seedB.document.id);
    await runCareerConsistencyAnalysis(seedA.document, jobData(seedA.candidate.id, seedA.project.id, seedA.document.id), "resume text", gateway, runA.id);
    await runCareerConsistencyAnalysis(seedB.document, jobData(seedB.candidate.id, seedB.project.id, seedB.document.id), "resume text", gateway, runB.id);

    const findingsA = await prisma.candidateConsistencyFinding.findMany({ where: { projectId: seedA.project.id } });
    const findingsB = await prisma.candidateConsistencyFinding.findMany({ where: { projectId: seedB.project.id } });
    expect(findingsA).toHaveLength(1);
    expect(findingsB).toHaveLength(1);
    expect(findingsA[0].candidateId).toBe(seedA.candidate.id);
    expect(findingsB[0].candidateId).toBe(seedB.candidate.id);
  });
});
