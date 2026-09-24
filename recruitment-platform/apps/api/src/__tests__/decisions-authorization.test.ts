import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 2 hardening, Section 3: /candidates/:id/decisions is now nested
 * under /projects/:projectId and gated by the same requireProjectAccess
 * used everywhere else — this proves it actually behaves that way, not
 * just that the route compiles.
 */
describe("decision route project authorization", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    app = await buildTestApp({ storage });
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupProjectAndCandidate(ownerEmail: string) {
    await createUser(ownerEmail, "HR_USER");
    const cookie = await loginAs(app, ownerEmail);
    const projectRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "HR Manager" },
    });
    const project = projectRes.json();
    const candidate = await prisma.candidate.create({ data: { fullName: "Jordan Doe" } });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: "Candidate #001" },
    });
    return { cookie, project, candidate };
  }

  it("denies an unrelated HR_USER from recording a decision on another project's candidate", async () => {
    const { project, candidate } = await setupProjectAndCandidate("owner@example.com");

    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/candidates/${candidate.id}/decisions`,
      headers: { cookie: outsiderCookie },
      payload: { decision: "SHORTLIST" },
    });
    expect(res.statusCode).toBe(404);

    const decisions = await prisma.hrDecision.findMany({ where: { candidateId: candidate.id } });
    expect(decisions).toHaveLength(0);
  });

  it("allows the project owner to record a decision", async () => {
    const { cookie, project, candidate } = await setupProjectAndCandidate("owner2@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/candidates/${candidate.id}/decisions`,
      headers: { cookie },
      payload: { decision: "INTERVIEW", notes: "Strong employee relations evidence." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe("INTERVIEW");
  });

  it("lets HR_ADMIN record a decision on a project they don't belong to", async () => {
    const { project, candidate } = await setupProjectAndCandidate("owner3@example.com");

    await createUser("admin@example.com", "HR_ADMIN");
    const adminCookie = await loginAs(app, "admin@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/candidates/${candidate.id}/decisions`,
      headers: { cookie: adminCookie },
      payload: { decision: "HOLD" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("lets SYSTEM_ADMIN record a decision on a project they don't belong to", async () => {
    const { project, candidate } = await setupProjectAndCandidate("owner4@example.com");

    await createUser("sysadmin@example.com", "SYSTEM_ADMIN");
    const sysadminCookie = await loginAs(app, "sysadmin@example.com");

    const res = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/candidates/${candidate.id}/decisions`,
      headers: { cookie: sysadminCookie },
      payload: { decision: "REJECT" },
    });
    expect(res.statusCode).toBe(200);
  });
});
