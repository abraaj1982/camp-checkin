import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import FormData from "form-data";
import { prisma } from "@recruitment-platform/db";
import { FakeCandidateDocumentQueue } from "@recruitment-platform/queue";
import type { ObjectStorage } from "@recruitment-platform/storage";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

// Real bytes, not just an extension — the route's validateUpload checks
// magic numbers, so a "corrupted" fixture must actually fail that check.
const VALID_PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, "x")]);
const VALID_DOCX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, "y")]);
const CORRUPTED_PDF_BYTES = Buffer.from("this is not a real pdf, just text pretending to be one");

async function multipartRequest(
  app: FastifyInstance,
  url: string,
  cookie: string,
  files: { filename: string; content: Buffer }[],
) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file.content, { filename: file.filename, contentType: "application/octet-stream" });
  }
  return app.inject({
    method: "POST",
    url,
    headers: { cookie, ...form.getHeaders() },
    payload: form.getBuffer(),
  });
}

describe("candidate CV batch upload and processing status (Phase 3)", () => {
  let app: FastifyInstance;
  let storage: ObjectStorage;
  let cleanupStorage: () => Promise<void>;
  let queue: FakeCandidateDocumentQueue;
  let cookie: string;
  let projectId: string;

  beforeEach(async () => {
    await resetDatabase();
    const created = await createTestStorage();
    storage = created.storage;
    cleanupStorage = created.cleanup;
    queue = new FakeCandidateDocumentQueue();
    app = await buildTestApp({ storage, queue });

    await createUser("hr@example.com", "HR_USER");
    cookie = await loginAs(app, "hr@example.com");
    const projectRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "HR Manager" },
    });
    projectId = projectRes.json().id;
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("uploads a batch of valid PDF/DOCX files: creates Candidate/CandidateProjectLink/CandidateDocument rows, stores the original bytes, and enqueues one job per document", async () => {
    const res = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
      { filename: "john_smith.docx", content: VALID_DOCX_BYTES },
    ]);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploaded).toHaveLength(2);
    expect(body.rejected).toHaveLength(0);

    const documents = await prisma.candidateDocument.findMany({ where: { projectId } });
    expect(documents).toHaveLength(2);
    expect(documents.every((d) => d.status === "QUEUED")).toBe(true);
    expect(documents.map((d) => d.originalFilename).sort()).toEqual(["jane-doe.pdf", "john_smith.docx"]);

    const links = await prisma.candidateProjectLink.findMany({ where: { projectId } });
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.anonymizedLabel).sort()).toEqual(["Candidate #001", "Candidate #002"]);

    expect(queue.enqueued).toHaveLength(2);
    expect(queue.enqueued.every((j) => j.projectId === projectId)).toBe(true);
  });

  it("stores the original bytes unchanged in object storage", async () => {
    const res = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);
    const { documentId } = res.json().uploaded[0];

    const document = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: documentId } });
    const storedBytes = await storage.getObject(document.storageKey);
    expect(storedBytes.equals(VALID_PDF_BYTES)).toBe(true);
  });

  it("rejects a corrupted/mislabeled file but still processes the rest of the batch", async () => {
    const res = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "good.pdf", content: VALID_PDF_BYTES },
      { filename: "bad.pdf", content: CORRUPTED_PDF_BYTES },
    ]);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.uploaded).toHaveLength(1);
    expect(body.uploaded[0].filename).toBe("good.pdf");
    expect(body.rejected).toEqual([{ filename: "bad.pdf", error: "corrupted_or_mislabeled_pdf" }]);

    // The rejected file never got a Candidate/CandidateDocument row at all.
    const documents = await prisma.candidateDocument.findMany({ where: { projectId } });
    expect(documents).toHaveLength(1);
  });

  it("rejects an unsupported file type", async () => {
    const res = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "notes.txt", content: Buffer.from("plain text") },
    ]);
    expect(res.json().rejected).toEqual([{ filename: "notes.txt", error: "unsupported_file_type" }]);
  });

  it("lists candidates with per-document processing status for the project", async () => {
    await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);

    const listRes = await app.inject({
      method: "GET",
      url: `/projects/${projectId}/candidates`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const links = listRes.json();
    expect(links).toHaveLength(1);
    expect(links[0].candidate.documents[0].status).toBe("QUEUED");
    expect(links[0].anonymizedLabel).toBe("Candidate #001");
  });

  it("denies upload access to an unrelated HR_USER (project authorization applies to Phase 3 routes too)", async () => {
    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");

    const res = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, outsiderCookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);
    expect(res.statusCode).toBe(404);

    const documents = await prisma.candidateDocument.findMany({ where: { projectId } });
    expect(documents).toHaveLength(0);
  });

  it("allows retrying a FAILED_RETRY document, re-queues it, and audits the retry", async () => {
    const uploadRes = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);
    const { candidateId, documentId } = uploadRes.json().uploaded[0];

    await prisma.candidateDocument.update({
      where: { id: documentId },
      data: { status: "FAILED_RETRY", failureReason: "Simulated parse failure." },
    });

    const retryRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/candidates/${candidateId}/documents/${documentId}/retry`,
      headers: { cookie },
    });
    expect(retryRes.statusCode).toBe(200);

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(updated.status).toBe("QUEUED");
    expect(updated.failureReason).toBeNull();
    expect(queue.enqueued.filter((j) => j.candidateDocumentId === documentId)).toHaveLength(2); // initial + retry

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: documentId } });
    expect(auditEntries.map((a) => a.action)).toContain("CANDIDATE_DOCUMENT_RETRY_REQUESTED");
  });

  it("never lets two concurrent retry requests both enqueue a job for the same document (Phase 4A ProcessingRun concurrency precondition)", async () => {
    // worker/src/processing-run.ts's startProcessingRun() unconditionally
    // marks every existing RUNNING run for a document FAILED when a new
    // attempt starts — it relies on this route making it impossible for two
    // jobs to ever be actively processing the same CandidateDocument at
    // once. That guarantee has to come from an atomic compare-and-swap on
    // this route, not a find-then-update (which two concurrent requests
    // could both pass). This proves exactly one of two simultaneous retry
    // requests succeeds.
    const uploadRes = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);
    const { candidateId, documentId } = uploadRes.json().uploaded[0];

    await prisma.candidateDocument.update({
      where: { id: documentId },
      data: { status: "FAILED_RETRY", failureReason: "Simulated parse failure." },
    });

    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/projects/${projectId}/candidates/${candidateId}/documents/${documentId}/retry`,
        headers: { cookie },
      }),
      app.inject({
        method: "POST",
        url: `/projects/${projectId}/candidates/${candidateId}/documents/${documentId}/retry`,
        headers: { cookie },
      }),
    ]);

    const statusCodes = [resA.statusCode, resB.statusCode].sort();
    expect(statusCodes).toEqual([200, 400]); // exactly one succeeds, the other sees it's no longer FAILED_RETRY

    // Only one new job was enqueued for this document by the retry (plus the initial upload job).
    expect(queue.enqueued.filter((j) => j.candidateDocumentId === documentId)).toHaveLength(2);
  });

  it("refuses to retry a document that is not in FAILED_RETRY status", async () => {
    const uploadRes = await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);
    const { candidateId, documentId } = uploadRes.json().uploaded[0];

    const retryRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/candidates/${candidateId}/documents/${documentId}/retry`,
      headers: { cookie },
    });
    expect(retryRes.statusCode).toBe(400);
    expect(retryRes.json().error).toBe("not_retryable");
  });

  it("records an audit entry for the upload batch", async () => {
    await multipartRequest(app, `/projects/${projectId}/candidates/upload`, cookie, [
      { filename: "jane-doe.pdf", content: VALID_PDF_BYTES },
    ]);

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: projectId, action: "CANDIDATE_DOCUMENTS_UPLOADED" } });
    expect(auditEntries).toHaveLength(1);
    expect((auditEntries[0].afterJson as { uploadedCount: number }).uploadedCount).toBe(1);
  });
});
