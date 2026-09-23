import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { LocalObjectStorage, buildCandidateDocumentKey } from "@recruitment-platform/storage";
import { runDocumentProcessingPipeline } from "../pipeline.js";
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
    const pdf = await buildTestPdf(
      "Jane Doe. HR Manager at Acme Corp since 2018. Led grievance handling and disciplinary " +
        "investigations across multiple regions. BA in Human Resources, State University. " +
        "Certified SHRM-CP. Fluent in English.",
    );
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
    const gateway = new AiGateway({ fake: new FakeAIProvider({ RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH }) });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.extractedText).toContain("Jane Doe");
    expect(updated.parsedAt).not.toBeNull();

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
    const docx = await buildTestDocx([
      "Jane Doe",
      "HR Manager at Acme Corp since 2018.",
      "Led grievance handling and disciplinary investigations across multiple regions.",
    ]);
    const { candidate, document } = await seedCandidateWithDocument(docx, "docx");
    const gateway = new AiGateway({ fake: new FakeAIProvider({ RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH }) });

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
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp. Led grievance handling.");
    const { candidate, document } = await seedCandidateWithDocument(pdf, "pdf");
    const gateway = new AiGateway({ fake: new FakeAIProvider({ RESUME_INTELLIGENCE: RESUME_INTELLIGENCE_HAPPY_PATH }) });

    await runDocumentProcessingPipeline(
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: "unused" },
      { storage, gateway },
    );

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    const storedBytes = await storage.getObject(updated.storageKey);
    expect(storedBytes.equals(pdf)).toBe(true); // byte-for-byte identical to what was uploaded
  });
});
