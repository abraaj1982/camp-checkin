import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError, type AIProvider, type AiRunRequest, type AiRunResult } from "@recruitment-platform/ai-gateway";
import { LocalObjectStorage, buildCandidateDocumentKey } from "@recruitment-platform/storage";
import { runDocumentProcessingPipeline } from "../pipeline.js";
import * as processingRunModule from "../processing-run.js";
import { buildTestDocx, buildTestPdf } from "./fixtures.js";
import { FakeAIProvider, createUser, resetDatabase, seedAiModelConfig } from "./test-utils.js";

const RESUME_INTELLIGENCE_HAPPY_PATH = {
  experiences: [
    {
      employer: "Acme Corp",
      title: "HR Manager",
      startDate: "2018-01-01",
      endDate: null,
      isCurrent: true,
      responsibilities: ["Led grievance handling and disciplinary investigations."],
      functionalAreaTags: ["Employee Relations"],
      sourcePage: 1,
      extractedConfidence: "HIGH",
    },
  ],
  education: [{ institution: "State University", degree: "BA", field: "HR", startDate: null, endDate: null }],
  skills: [{ skillName: "Conflict resolution", category: null }],
  certifications: [{ name: "SHRM-CP", issuer: "SHRM", dateObtained: null }],
  languages: [{ language: "English", proficiency: "Native" }],
};

const CAREER_CONSISTENCY_HAPPY_PATH = {
  progressionNarrative: "Steady, consistent HR career progression with no gaps.",
  findings: [],
};

describe("runDocumentProcessingPipeline", () => {
  let storageDir: string;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(join(tmpdir(), "rip-worker-test-storage-"));
    storage = new LocalObjectStorage(storageDir);
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedCandidateWithDocument(buffer: Buffer, fileType: "pdf" | "docx") {
    const user = await createUser("hr@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType,
        storageKey: "pending",
        originalFilename: `resume.${fileType}`,
        fileSizeBytes: buffer.byteLength,
        status: "QUEUED",
        uploadedBy: user.id,
      },
    });
    const storageKey = buildCandidateDocumentKey({
      projectId: project.id,
      candidateId: candidate.id,
      documentId: document.id,
      fileExtension: fileType,
    });
    await storage.putObject({
      key: storageKey,
      body: buffer,
      contentType: fileType === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await prisma.candidateDocument.update({ where: { id: document.id }, data: { storageKey } });
    return { project, candidate, document };
  }

  it("parses a PDF, extracts via Resume Intelligence, and persists the normalized profile", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const pdf = await buildTestPdf(
      "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
        "investigations across multiple regions. BA in Human Resources, State University. " +
        "Certified SHRM-CP. Fluent in English.",
    );
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
      }),
    });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.extractedText).toContain("Jane Doe");
    expect(updated.parsedAt).not.toBeNull();

    // Phase 4A: a successful pipeline run creates exactly one COMPLETED
    // ProcessingRun and promotes it to currentProcessingRunId.
    expect(updated.currentProcessingRunId).not.toBeNull();
    const run = await prisma.processingRun.findUniqueOrThrow({ where: { id: updated.currentProcessingRunId! } });
    expect(run.status).toBe("COMPLETED");
    expect(run.attemptNumber).toBe(1);

    const experiences = await prisma.candidateExperience.findMany({ where: { candidateId: candidate.id } });
    expect(experiences).toHaveLength(1);
    expect(experiences[0].employer).toBe("Acme Corp");
    expect(experiences[0].functionalAreaTags).toEqual(["Employee Relations"]);
    expect(experiences[0].documentId).toBe(document.id);

    const education = await prisma.candidateEducation.findMany({ where: { candidateId: candidate.id } });
    expect(education).toHaveLength(1);
    const certifications = await prisma.candidateCertification.findMany({ where: { candidateId: candidate.id } });
    expect(certifications[0].name).toBe("SHRM-CP");

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: document.id } });
    expect(auditEntries.map((a) => a.action)).toContain("CANDIDATE_DOCUMENT_PROCESSED");
  });

  it("parses a DOCX the same way", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const docx = await buildTestDocx([
      "Jane Doe",
      "HR Manager at Acme Corp since 2018.",
      "Led grievance handling and disciplinary investigations across multiple regions.",
    ]);
    const { candidate, document } = await seedCandidateWithDocument(docx, "docx");
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
      }),
    });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.extractedText).toContain("Jane Doe");
    // DOCX has no fixed pagination (Phase 3 spec) — pageTexts stays null.
    expect(updated.extractedPageTexts).toBeNull();
  });

  it("marks a near-empty (image-only) PDF as FAILED_NEEDS_OCR without throwing", async () => {
    const blankPdf = await buildTestPdf(""); // pdfkit still emits a valid PDF with ~no extractable text
    const { candidate, document } = await seedCandidateWithDocument(blankPdf, "pdf");
    const gateway = new AiGateway({});

    await expect(
      runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      ),
    ).resolves.toBeUndefined(); // terminal state, not a thrown/retryable error

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("FAILED_NEEDS_OCR");
    expect(updated.failureReason).toContain("scanned/image-only");

    const experiences = await prisma.candidateExperience.findMany({ where: { candidateId: candidate.id } });
    expect(experiences).toHaveLength(0); // no AI call was made, nothing persisted
  });

  it("throws AiValidationError (retryable) when the AI response fails schema validation", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    const pdf = await buildTestPdf(
      "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
        "investigations across multiple regions.",
    );
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
    // Missing required fields -> fails resumeIntelligenceOutputSchema even after the gateway's one retry.
    const gateway = new AiGateway({
      fake: new FakeAIProvider({ RESUME_INTELLIGENCE: { experiences: "not an array" } }),
    });

    await expect(
      runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      ),
    ).rejects.toBeInstanceOf(AiValidationError);

    // The caller (worker/src/index.ts) is responsible for marking
    // FAILED_RETRY on this throw — the pipeline itself leaves status alone
    // (still whatever it was before this call, QUEUED here since this test
    // calls the pipeline directly rather than through the worker's job
    // handler) so a caller-level retry loop can decide independently.
    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("QUEUED");

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: document.id } });
    expect(auditEntries.map((a) => a.action)).toContain("CANDIDATE_DOCUMENT_AI_EXTRACTION_FAILED");
  });

  it("never overwrites the original document bytes in storage during processing", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp. Led grievance handling.");
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
      }),
    });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    const storedBytes = await storage.getObject(updated.storageKey);
    expect(storedBytes.equals(pdf)).toBe(true); // byte-for-byte identical to what was uploaded
  });

  it("does not mark the document COMPLETED if Resume Intelligence succeeds but Requirement Evidence Analysis fails (Decision 5)", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling.");
    const { project, candidate, document } = await seedCandidateWithDocument(pdf, "pdf");

    // Pin a requirement to this document's batch so evidence analysis
    // actually runs (rather than returning early for lack of a batch).
    const user = await prisma.user.findFirstOrThrow();
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Employee Relations",
        mandatory: true,
        status: "APPROVED",
        currentVersionNumber: 1,
      },
    });
    const version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: 1,
        category: requirement.category,
        description: requirement.description,
        mandatory: true,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 100,
        approvedBy: user.id,
      },
    });
    const batch = await prisma.candidateUploadBatch.create({ data: { projectId: project.id, createdBy: user.id } });
    await prisma.candidateBatchRequirementVersion.create({
      data: { batchId: batch.id, requirementId: requirement.id, requirementVersionId: version.id },
    });
    await prisma.candidateDocument.update({ where: { id: document.id }, data: { batchId: batch.id } });

    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
        // Violates evidenceCandidates.min(1) -> fails schema validation even after the gateway's retry.
        REQUIREMENT_EVIDENCE_ANALYSIS: { items: [{ requirementId: requirement.id, evidenceCandidates: [] }] },
      }),
    });

    await expect(
      runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id },
        { storage, gateway },
      ),
    ).rejects.toBeInstanceOf(AiValidationError);

    // Resume Intelligence's own writes (extracted text, profile rows) did
    // persist — but the document must NOT read as COMPLETED, since the
    // pipeline as a whole did not finish.
    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).not.toBe("COMPLETED");
    expect(updated.extractedText).toContain("Jane Doe");
    expect(updated.currentProcessingRunId).toBeNull(); // a failed run never becomes current
    const experiences = await prisma.candidateExperience.findMany({ where: { candidateId: candidate.id } });
    expect(experiences).toHaveLength(1); // Resume Intelligence's persistence still happened

    // The ProcessingRun this attempt created is FAILED, not left RUNNING.
    const runs = await prisma.processingRun.findMany({ where: { candidateDocumentId: document.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("FAILED");
  });

  it("does not mark the document COMPLETED if Career Consistency Analysis fails (required pipeline step, Decision A)", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling.");
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");

    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        // Missing "findings" -> fails careerConsistencyOutputSchema even after the gateway's retry.
        CAREER_CONSISTENCY_ANALYSIS: { progressionNarrative: "Narrative only, no findings array." },
      }),
    });

    await expect(
      runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      ),
    ).rejects.toBeInstanceOf(AiValidationError);

    // Career Consistency is a REQUIRED step (Decision A) — its failure fails
    // the whole ProcessingRun exactly like a Requirement Evidence Analysis
    // failure, with no partial-success status. The document is never left
    // reading as COMPLETED, and currentProcessingRunId stays null. The
    // caller (worker/src/index.ts) is what actually flips the document to
    // FAILED_RETRY on this throw — the pipeline itself leaves status alone,
    // same established pattern as every other pipeline-step failure test above.
    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).not.toBe("COMPLETED");
    expect(updated.currentProcessingRunId).toBeNull();

    const runs = await prisma.processingRun.findMany({ where: { candidateDocumentId: document.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("FAILED"); // not RUNNING, and no partial-success status exists

    // Requirement Evidence Analysis never even runs when Career Consistency
    // fails first (it's ordered before it) — no Assessment rows exist.
    expect(await prisma.assessment.count({ where: { candidateId: candidate.id } })).toBe(0);

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: document.id } });
    expect(auditEntries.map((a) => a.action)).toContain("CANDIDATE_CONSISTENCY_ANALYSIS_AI_FAILED");
  });

  it("reaches COMPLETED when Career Consistency succeeds, and persists its findings alongside the rest of the pipeline's output", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling.");
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");

    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
        CAREER_CONSISTENCY_ANALYSIS: {
          progressionNarrative: "This narrative must not be persisted anywhere.",
          findings: [
            {
              findingType: "EMPLOYMENT_GAP",
              severity: "INFORMATION_UNCLEAR",
              description: "Gap between two roles.",
              sourcePage: null,
              evidenceText: null,
              confidence: "MEDIUM",
            },
          ],
        },
      }),
    });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.currentProcessingRunId).not.toBeNull();

    const findings = await prisma.candidateConsistencyFinding.findMany({ where: { candidateId: candidate.id } });
    expect(findings).toHaveLength(1);
    expect(findings[0].sourceDocumentId).toBe(document.id);
    expect(findings[0].sourcePage).toBeNull();
    expect(findings[0].evidenceText).toBeNull();
  });

  it("Phase 10 — a run reclaimed mid-flight (between its AI call and its write transaction) writes nothing and never becomes current", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const pdf = await buildTestPdf(
      "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling. BA, State University.",
    );
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");

    // Simulates a reclaim job ending this document's ProcessingRun WHILE
    // the Resume Intelligence call is still "in flight" — the exact race
    // traced in Phase 10A: the run is legitimately RUNNING when the AI
    // call starts, but no longer owns the document by the time the
    // pipeline reaches its write transaction. A bespoke AIProvider (not
    // FakeAIProvider, whose function-response values aren't awaited)
    // performs and AWAITS the reclaim update before returning, so the
    // reclaim is guaranteed to have committed before the pipeline's
    // write transaction runs.
    class ReclaimDuringCallProvider implements AIProvider {
      readonly name = "fake";
      async run(request: AiRunRequest): Promise<AiRunResult> {
        if (request.taskType === "RESUME_INTELLIGENCE") {
          await prisma.processingRun.updateMany({
            where: { candidateDocumentId: document.id, status: "RUNNING" },
            data: { status: "FAILED", completedAt: new Date() },
          });
          return { rawText: JSON.stringify(RESUME_INTELLIGENCE_HAPPY_PATH) };
        }
        return { rawText: JSON.stringify(CAREER_CONSISTENCY_HAPPY_PATH) };
      }
    }
    const gateway = new AiGateway({ fake: new ReclaimDuringCallProvider() });

    await expect(
      runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      ),
    ).rejects.toThrow("no longer RUNNING");

    // Nothing from the reclaimed run's write transaction persisted.
    const experiences = await prisma.candidateExperience.findMany({ where: { candidateId: candidate.id } });
    expect(experiences).toHaveLength(0);
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.currentProcessingRunId).toBeNull();
    // Status is whatever it was before this call (this test calls the
    // pipeline directly, bypassing worker/src/index.ts's own PROCESSING
    // write) — the point being verified is what it is NOT: never flipped
    // to FAILED_RETRY or COMPLETED by the reclaimed run itself.
    expect(updatedDoc.status).toBe("QUEUED");
  });

  describe("Phase 10D — heartbeat lifecycle", () => {
    // Spying directly on startHeartbeat proves start/stop calls precisely
    // and avoids mixing vi.useFakeTimers() with the pipeline's real,
    // multi-step Prisma I/O (which does not tolerate fake timers well —
    // confirmed empirically: wrapping the full pipeline call in fake
    // timers caused it to silently stop completing its own awaits).
    function spyOnStartHeartbeat() {
      return vi.spyOn(processingRunModule, "startHeartbeat");
    }
    let stopSpy: ReturnType<typeof vi.fn>;
    let startHeartbeatSpy: ReturnType<typeof spyOnStartHeartbeat>;

    beforeEach(() => {
      stopSpy = vi.fn();
      startHeartbeatSpy = vi.spyOn(processingRunModule, "startHeartbeat").mockReturnValue({ stop: stopSpy });
    });

    afterEach(() => {
      startHeartbeatSpy.mockRestore();
    });

    it("(1) heartbeat starts after startProcessingRun successfully establishes ownership", async () => {
      await seedAiModelConfig("RESUME_INTELLIGENCE");
      await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
      const pdf = await buildTestPdf(
        "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
          "investigations across multiple regions. BA in Human Resources, State University. " +
          "Certified SHRM-CP. Fluent in English.",
      );
      const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
      const gateway = new AiGateway({
        fake: new FakeAIProvider({
          RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
          CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
        }),
      });

      await runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      );

      expect(startHeartbeatSpy).toHaveBeenCalledTimes(1);
      const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(startHeartbeatSpy.mock.calls[0][0]).toBe(updatedDoc.currentProcessingRunId); // started with the correct run id
    });

    it("(2) heartbeat stops on successful completion", async () => {
      await seedAiModelConfig("RESUME_INTELLIGENCE");
      await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
      const pdf = await buildTestPdf(
        "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
          "investigations across multiple regions. BA in Human Resources, State University. " +
          "Certified SHRM-CP. Fluent in English.",
      );
      const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
      const gateway = new AiGateway({
        fake: new FakeAIProvider({
          RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH,
          CAREER_CONSISTENCY_ANALYSIS: CAREER_CONSISTENCY_HAPPY_PATH,
        }),
      });

      await runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      );

      expect(stopSpy).toHaveBeenCalledTimes(1);
      const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(updatedDoc.status).toBe("COMPLETED");
    });

    it("(4) heartbeat stops on the OCR terminal path", async () => {
      const scannedPdf = await buildTestPdf(" ");
      const { candidate, document } = await seedCandidateWithDocument(scannedPdf, "pdf");
      const gateway = new AiGateway({ fake: new FakeAIProvider({}) });

      await runDocumentProcessingPipeline(
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
        { storage, gateway },
      );

      expect(stopSpy).toHaveBeenCalledTimes(1);
      const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(updatedDoc.status).toBe("FAILED_NEEDS_OCR");
    });

    it("(3) heartbeat stops on ordinary processing failure", async () => {
      await seedAiModelConfig("RESUME_INTELLIGENCE");
      const pdf = await buildTestPdf(
        "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
          "investigations across multiple regions. BA in Human Resources, State University. " +
          "Certified SHRM-CP. Fluent in English.",
      );
      const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
      const badGateway = new AiGateway({
        fake: new FakeAIProvider({ RESUME_INTELLIGENCE: () => ({ invalid: "shape" }) }),
      });

      await expect(
        runDocumentProcessingPipeline(
          { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
          { storage, gateway: badGateway },
        ),
      ).rejects.toBeInstanceOf(AiValidationError);

      expect(stopSpy).toHaveBeenCalledTimes(1);
      const run = await prisma.processingRun.findFirstOrThrow({ where: { candidateDocumentId: document.id } });
      expect(run.status).toBe("FAILED");
    });

    it("(5) heartbeat stops after ProcessingRunNoLongerActiveError (reclaimed mid-flight)", async () => {
      await seedAiModelConfig("RESUME_INTELLIGENCE");
      const pdf = await buildTestPdf(
        "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
          "investigations across multiple regions. BA in Human Resources, State University. " +
          "Certified SHRM-CP. Fluent in English.",
      );
      const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");

      class ReclaimDuringCallProvider implements AIProvider {
        readonly name = "fake";
        async run(request: AiRunRequest): Promise<AiRunResult> {
          if (request.taskType === "RESUME_INTELLIGENCE") {
            await prisma.processingRun.updateMany({
              where: { candidateDocumentId: document.id, status: "RUNNING" },
              data: { status: "FAILED", completedAt: new Date() },
            });
            return { rawText: JSON.stringify(RESUME_INTELLIGENCE_HAPPY_PATH) };
          }
          return { rawText: JSON.stringify(CAREER_CONSISTENCY_HAPPY_PATH) };
        }
      }
      const gateway = new AiGateway({ fake: new ReclaimDuringCallProvider() });

      await expect(
        runDocumentProcessingPipeline(
          { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
          { storage, gateway },
        ),
      ).rejects.toThrow("no longer RUNNING");

      expect(stopSpy).toHaveBeenCalledTimes(1);
    });
  });
});
