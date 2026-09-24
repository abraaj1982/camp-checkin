import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import { buildStagedUploadKey } from "@recruitment-platform/storage";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";
import { buildTestPdf } from "./pdf-fixtures.js";

/**
 * Phase 7 — Candidate Deduplication. Covers the admin-only resolution
 * transaction (LINK_EXISTING/CREATE_NEW), including the mandatory
 * matchSignal identity-enrichment rules, concurrency/idempotency, and
 * authorization/privacy boundaries. Identity-resolution classification
 * itself (EMAIL/PHONE/BOTH/CONFLICT detection) is covered in
 * worker/src/__tests__/identity-resolution.test.ts.
 */
describe("Candidate Match Review resolution (Phase 7, admin-only)", () => {
  let app: FastifyInstance;
  let storage: ObjectStorage;
  let cleanupStorage: () => Promise<void>;
  let adminCookie: string;

  beforeEach(async () => {
    await resetDatabase();
    const created = await createTestStorage();
    storage = created.storage;
    cleanupStorage = created.cleanup;
    app = await buildTestApp({ storage });
    await createUser("admin@example.com", "HR_ADMIN");
    adminCookie = await loginAs(app, "admin@example.com");
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProjectAndStagedUpload(text: string) {
    const owner = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`, "HR_USER");
    const ownerCookie = await loginAs(app, owner.email);
    const projectRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "HR Manager" },
    });
    const project = projectRes.json();

    const pdf = await buildTestPdf(text);
    const stagedUpload = await prisma.stagedUpload.create({
      data: {
        projectId: project.id,
        fileType: "pdf",
        storageKey: "pending",
        originalFilename: "jane-doe-resume.pdf",
        fileSizeBytes: pdf.byteLength,
        uploadedBy: owner.id,
      },
    });
    const storageKey = buildStagedUploadKey({ projectId: project.id, stagedUploadId: stagedUpload.id, fileExtension: "pdf" });
    await storage.putObject({ key: storageKey, body: pdf, contentType: "application/pdf" });
    const updated = await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { storageKey } });

    return { project, owner, ownerCookie, stagedUpload: updated };
  }

  function resolve(cookie: string, reviewId: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/admin/candidate-match-reviews/${reviewId}/resolve`,
      headers: { cookie },
      payload: body,
    });
  }

  it("EMAIL matchSignal: LINK_EXISTING fills only the missing phone field, never touches the already-correct email", async () => {
    const candidate = await prisma.candidate.create({
      data: { fullName: "Jane Doe", email: "jane@example.com", normalizedEmail: "jane@example.com" },
    });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const res = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });
    expect(res.statusCode).toBe(200);

    const updated = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(updated.email).toBe("jane@example.com"); // unchanged
    expect(updated.normalizedPhone).toBe("5551234567"); // filled — matchSignal proved phone matched no one else
    expect(updated.phone).toBe("555-123-4567");

    const document = await prisma.candidateDocument.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(document.storageKey).toBe(stagedUpload.storageKey);
  });

  it("PHONE matchSignal: LINK_EXISTING fills only the missing email field", async () => {
    const candidate = await prisma.candidate.create({
      data: { fullName: "Jane Doe", phone: "555-123-4567", normalizedPhone: "5551234567" },
    });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "PHONE", phoneMatchedCandidateId: candidate.id },
    });

    await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });

    const updated = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(updated.phone).toBe("555-123-4567"); // unchanged
    expect(updated.normalizedEmail).toBe("jane@example.com"); // filled
  });

  it("BOTH matchSignal: no enrichment — both fields already set and correct", async () => {
    const candidate = await prisma.candidate.create({
      data: {
        fullName: "Jane Doe", email: "jane@example.com", normalizedEmail: "jane@example.com",
        phone: "555-123-4567", normalizedPhone: "5551234567",
      },
    });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: {
        stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "BOTH",
        emailMatchedCandidateId: candidate.id, phoneMatchedCandidateId: candidate.id,
      },
    });

    await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });

    const updated = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(updated.email).toBe("jane@example.com");
    expect(updated.phone).toBe("555-123-4567");
  });

  it("CONFLICT matchSignal — CRITICAL: choosing candidate B (matched by phone) never copies candidate A's email onto B", async () => {
    const candidateA = await prisma.candidate.create({
      data: { fullName: "Candidate A", email: "jane@example.com", normalizedEmail: "jane@example.com" },
    });
    const candidateB = await prisma.candidate.create({
      data: { fullName: "Candidate B", phone: "555-999-8888", normalizedPhone: "5559998888" },
    });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: {
        stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "CONFLICT",
        emailMatchedCandidateId: candidateA.id, phoneMatchedCandidateId: candidateB.id,
      },
    });

    const res = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidateB.id });
    expect(res.statusCode).toBe(200);

    const updatedA = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateA.id } });
    const updatedB = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateB.id } });
    // Candidate A is completely untouched.
    expect(updatedA.email).toBe("jane@example.com");
    expect(updatedA.phone).toBeNull();
    // Candidate B never receives the email that belongs to candidate A — the contamination bug.
    expect(updatedB.email).toBeNull();
    expect(updatedB.normalizedEmail).toBeNull();
    expect(updatedB.phone).toBe("555-999-8888"); // its own field, unchanged
  });

  it("CONFLICT matchSignal: rejects a LINK_EXISTING candidateId that isn't one of the review's own matches", async () => {
    const candidateA = await prisma.candidate.create({ data: { fullName: "Candidate A", normalizedEmail: "jane@example.com" } });
    const candidateB = await prisma.candidate.create({ data: { fullName: "Candidate B", normalizedPhone: "5559998888" } });
    const unrelated = await prisma.candidate.create({ data: { fullName: "Unrelated Candidate" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: {
        stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "CONFLICT",
        emailMatchedCandidateId: candidateA.id, phoneMatchedCandidateId: candidateB.id,
      },
    });

    const res = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: unrelated.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_link_target");
  });

  it("reuses an existing CandidateProjectLink instead of creating a duplicate", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: "Candidate #007" },
    });
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });

    const links = await prisma.candidateProjectLink.findMany({ where: { candidateId: candidate.id, projectId: project.id } });
    expect(links).toHaveLength(1);
    expect(links[0].anonymizedLabel).toBe("Candidate #007"); // reused, not replaced
  });

  it("creates a new CandidateProjectLink when the matched candidate is not yet linked to this project", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });

    const links = await prisma.candidateProjectLink.findMany({ where: { candidateId: candidate.id, projectId: project.id } });
    expect(links).toHaveLength(1);
  });

  it("CREATE_NEW: preserves both originally-matched candidates untouched, and creates a genuinely new Candidate using deriveFullNameFromFilename", async () => {
    const candidateA = await prisma.candidate.create({ data: { fullName: "Candidate A", normalizedEmail: "jane@example.com" } });
    const candidateB = await prisma.candidate.create({ data: { fullName: "Candidate B", normalizedPhone: "5559998888" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: {
        stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "CONFLICT",
        emailMatchedCandidateId: candidateA.id, phoneMatchedCandidateId: candidateB.id,
      },
    });

    const res = await resolve(adminCookie, review.id, { outcome: "CREATE_NEW" });
    expect(res.statusCode).toBe(200);

    const newCandidateId = res.json().candidateId;
    expect(newCandidateId).not.toBe(candidateA.id);
    expect(newCandidateId).not.toBe(candidateB.id);

    const newCandidate = await prisma.candidate.findUniqueOrThrow({ where: { id: newCandidateId } });
    expect(newCandidate.fullName).toBe("jane doe resume"); // deriveFullNameFromFilename behavior preserved exactly
    expect(newCandidate.normalizedEmail).toBe("jane@example.com");

    // Both originally-matched candidates are completely unmodified.
    const stillA = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateA.id } });
    const stillB = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateB.id } });
    expect(stillA.normalizedEmail).toBe("jane@example.com");
    expect(stillA.normalizedPhone).toBeNull();
    expect(stillB.normalizedPhone).toBe("5559998888");

    // The review still references both, permanently, even though neither was chosen.
    const finalReview = await prisma.candidateMatchReview.findUniqueOrThrow({ where: { id: review.id } });
    expect(finalReview.emailMatchedCandidateId).toBe(candidateA.id);
    expect(finalReview.phoneMatchedCandidateId).toBe(candidateB.id);
    expect(finalReview.status).toBe("CREATE_NEW");
  });

  it("concurrent resolution attempts: exactly one succeeds, no duplicate Candidate/CandidateDocument", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const [resA, resB] = await Promise.all([
      resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id }),
      resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id }),
    ]);

    const statusCodes = [resA.statusCode, resB.statusCode].sort();
    expect(statusCodes).toEqual([200, 409]);
    expect(await prisma.candidateDocument.count({ where: { candidateId: candidate.id } })).toBe(1);
  });

  it("duplicate resolution request (retry/double-submit): second attempt is rejected, no second Candidate/CandidateDocument", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const first = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });
    expect(first.statusCode).toBe(200);
    const second = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("already_resolved");

    expect(await prisma.candidateDocument.count({ where: { candidateId: candidate.id } })).toBe(1);
    expect(await prisma.candidateProjectLink.count({ where: { candidateId: candidate.id, projectId: project.id } })).toBe(1);
  });

  it("authorization: denies a non-admin HR_USER on both list and resolve (403), allows HR_ADMIN and SYSTEM_ADMIN", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const hrUser = await createUser("plain-hr@example.com", "HR_USER");
    const hrCookie = await loginAs(app, hrUser.email);

    const listRes = await app.inject({ method: "GET", url: "/admin/candidate-match-reviews", headers: { cookie: hrCookie } });
    expect(listRes.statusCode).toBe(403);
    const resolveRes = await resolve(hrCookie, review.id, { outcome: "CREATE_NEW" });
    expect(resolveRes.statusCode).toBe(403);

    const sysadmin = await createUser("sysadmin@example.com", "SYSTEM_ADMIN");
    const sysadminCookie = await loginAs(app, sysadmin.email);
    const sysadminList = await app.inject({ method: "GET", url: "/admin/candidate-match-reviews", headers: { cookie: sysadminCookie } });
    expect(sysadminList.statusCode).toBe(200);
  });

  it("privacy: the admin list/resolve responses never contain a raw or normalized email/phone value", async () => {
    const candidate = await prisma.candidate.create({
      data: { fullName: "Jane Doe", email: "jane@example.com", normalizedEmail: "jane@example.com" },
    });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const listRes = await app.inject({ method: "GET", url: "/admin/candidate-match-reviews", headers: { cookie: adminCookie } });
    expect(listRes.body).not.toContain("jane@example.com");
    expect(listRes.body).not.toContain("555-123-4567");
    expect(listRes.body).not.toContain("5551234567");
    const listBody = listRes.json();
    expect(listBody[0].matchSignal).toBe("EMAIL");
    expect(listBody[0].emailMatch.candidateName).toBe("Jane Doe");

    const resolveRes = await resolve(adminCookie, review.id, { outcome: "LINK_EXISTING", candidateId: candidate.id });
    expect(resolveRes.body).not.toContain("jane@example.com");
    expect(resolveRes.body).not.toContain("555-123-4567");
  });

  it("rejects an invalid outcome value", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    const { stagedUpload, project } = await seedProjectAndStagedUpload( "Jane Doe. Email: jane@example.com.");
    const review = await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const res = await resolve(adminCookie, review.id, { outcome: "MERGE" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_outcome");
  });
});
