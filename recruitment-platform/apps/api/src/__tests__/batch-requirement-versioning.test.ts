import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

const VALID_PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, "x")]);

async function uploadOne(app: FastifyInstance, url: string, cookie: string, filename: string) {
  const form = new FormData();
  form.append("files", VALID_PDF_BYTES, { filename, contentType: "application/octet-stream" });
  return app.inject({ method: "POST", url, headers: { cookie, ...form.getHeaders() }, payload: form.getBuffer() });
}

/**
 * Phase 4 foundation, Decision 3: the latest APPROVED JobRequirementVersion
 * is resolved once when a batch (= one upload call) is created, pinned in
 * CandidateBatchRequirementVersion, and never re-resolved per candidate —
 * so every document in one upload call, and every candidate that will
 * later be assessed from it, is evaluated against the exact same version.
 */
describe("batch requirement-version pinning", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;
  let cookie: string;
  let projectId: string;
  let requirementId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    app = await buildTestApp({ storage });

    await createUser("hr@example.com", "HR_USER");
    cookie = await loginAs(app, "hr@example.com");
    const projectRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "HR Manager" },
    });
    projectId = projectRes.json().id;

    const reqRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: { category: "FUNCTIONAL_EXPERIENCE", description: "5 years Employee Relations", mandatory: true },
    });
    requirementId = reqRes.json().id;

    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirementId}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("pins the latest approved version to the batch and to every document's batchId", async () => {
    const versionBeforeUpload = await prisma.jobRequirementVersion.findFirstOrThrow({
      where: { requirementId },
      orderBy: { versionNumber: "desc" },
    });

    const uploadRes = await uploadOne(app, `/projects/${projectId}/candidates/upload`, cookie, "jane.pdf");
    const { batchId, uploaded } = uploadRes.json();
    expect(batchId).toBeTruthy();

    const pins = await prisma.candidateBatchRequirementVersion.findMany({ where: { batchId } });
    expect(pins).toHaveLength(1);
    expect(pins[0].requirementId).toBe(requirementId);
    expect(pins[0].requirementVersionId).toBe(versionBeforeUpload.id);

    const document = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: uploaded[0].documentId } });
    expect(document.batchId).toBe(batchId);
  });

  it("keeps two upload batches pinned to different versions when the requirement is edited and re-approved in between", async () => {
    const firstUpload = await uploadOne(app, `/projects/${projectId}/candidates/upload`, cookie, "candidate-a.pdf");
    const firstBatchId = firstUpload.json().batchId;
    const firstPin = await prisma.candidateBatchRequirementVersion.findFirstOrThrow({
      where: { batchId: firstBatchId },
    });
    const firstVersion = await prisma.jobRequirementVersion.findUniqueOrThrow({
      where: { id: firstPin.requirementVersionId },
    });
    expect(firstVersion.versionNumber).toBe(1);

    // Edit (moves to CHANGED) then re-approve (creates version 2).
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirementId}`,
      headers: { cookie },
      payload: { description: "7 years Employee Relations" },
    });
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirementId}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    await app.inject({ method: "POST", url: `/projects/${projectId}/requirements/approve`, headers: { cookie } });

    const secondUpload = await uploadOne(app, `/projects/${projectId}/candidates/upload`, cookie, "candidate-b.pdf");
    const secondBatchId = secondUpload.json().batchId;
    const secondPin = await prisma.candidateBatchRequirementVersion.findFirstOrThrow({
      where: { batchId: secondBatchId },
    });
    const secondVersion = await prisma.jobRequirementVersion.findUniqueOrThrow({
      where: { id: secondPin.requirementVersionId },
    });
    expect(secondVersion.versionNumber).toBe(2);
    expect(secondVersion.description).toBe("7 years Employee Relations");

    // The first batch's pin is untouched by the later re-approval — proving
    // the resolve-once-at-creation guarantee, not a live "current version" lookup.
    const firstPinReread = await prisma.candidateBatchRequirementVersion.findUniqueOrThrow({
      where: { id: firstPin.id },
    });
    expect(firstPinReread.requirementVersionId).toBe(firstVersion.id);
  });

  it("pins the same version for every candidate uploaded in one batch call", async () => {
    const form = new FormData();
    form.append("files", VALID_PDF_BYTES, { filename: "candidate-a.pdf", contentType: "application/octet-stream" });
    form.append("files", VALID_PDF_BYTES, { filename: "candidate-b.pdf", contentType: "application/octet-stream" });
    form.append("files", VALID_PDF_BYTES, { filename: "candidate-c.pdf", contentType: "application/octet-stream" });

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/candidates/upload`,
      headers: { cookie, ...form.getHeaders() },
      payload: form.getBuffer(),
    });
    const { batchId, uploaded } = res.json();
    expect(uploaded).toHaveLength(3);

    const documents = await prisma.candidateDocument.findMany({
      where: { id: { in: uploaded.map((u: { documentId: string }) => u.documentId) } },
    });
    expect(documents.every((d) => d.batchId === batchId)).toBe(true);

    // Only one pin exists for the whole batch — every one of the three
    // candidates' future Assessment rows would resolve to this same row,
    // never a separate lookup per candidate.
    const pins = await prisma.candidateBatchRequirementVersion.findMany({ where: { batchId } });
    expect(pins).toHaveLength(1);
  });

  it("creates no pin for a requirement that has never been approved, without failing the upload", async () => {
    const secondReqRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: { category: "TECHNICAL_SKILLS", description: "Advanced Excel", mandatory: false },
    });
    expect(secondReqRes.json().status).toBe("DRAFT"); // never approved

    const res = await uploadOne(app, `/projects/${projectId}/candidates/upload`, cookie, "jane.pdf");
    expect(res.statusCode).toBe(200);

    const pins = await prisma.candidateBatchRequirementVersion.findMany({ where: { batchId: res.json().batchId } });
    expect(pins).toHaveLength(1); // only the approved requirement got pinned
    expect(pins[0].requirementId).toBe(requirementId);
  });

  it("denies batch upload (and therefore version pinning) to an unrelated HR_USER", async () => {
    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");

    const res = await uploadOne(app, `/projects/${projectId}/candidates/upload`, outsiderCookie, "jane.pdf");
    expect(res.statusCode).toBe(404);

    const batches = await prisma.candidateUploadBatch.findMany({ where: { projectId } });
    expect(batches).toHaveLength(0);
  });
});
