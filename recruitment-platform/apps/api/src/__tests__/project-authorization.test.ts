import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { buildApp } from "../app.js";
import { createUser, loginAs, resetDatabase } from "./test-utils.js";

describe("project-level authorization (Phase 2, Section 1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await resetDatabase();
    app = await buildApp({
      sessionSecret: "test-session-secret-not-for-production-use-only",
      nodeEnv: "test",
      providers: {},
      logger: false,
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets the project creator (OWNER) access their own project", async () => {
    const owner = await createUser("owner@example.com", "HR_USER");
    const cookie = await loginAs(app, "owner@example.com");

    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "Senior HR Manager" },
    });
    expect(createRes.statusCode).toBe(200);
    const project = createRes.json();

    const getRes = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(project.id);
    void owner;
  });

  it("blocks an unrelated HR_USER from reaching another project by ID (404, not 403)", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Confidential Search" },
    });
    const project = createRes.json();

    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");

    const getRes = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie: outsiderCookie },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it("lets an HR_USER access a project once explicitly assigned as a member", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Team Project" },
    });
    const project = createRes.json();

    const teammate = await createUser("teammate@example.com", "HR_USER");
    const teammateCookie = await loginAs(app, "teammate@example.com");

    const beforeAssign = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie: teammateCookie },
    });
    expect(beforeAssign.statusCode).toBe(404);

    const assignRes = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/members`,
      headers: { cookie: ownerCookie },
      payload: { userId: teammate.id, role: "MEMBER" },
    });
    expect(assignRes.statusCode).toBe(200);

    const afterAssign = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie: teammateCookie },
    });
    expect(afterAssign.statusCode).toBe(200);
  });

  it("lets HR_ADMIN access any project without explicit membership", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Admin Visible Project" },
    });
    const project = createRes.json();

    await createUser("admin@example.com", "HR_ADMIN");
    const adminCookie = await loginAs(app, "admin@example.com");

    const getRes = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie: adminCookie },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it("lets SYSTEM_ADMIN access any project without explicit membership", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "System Admin Visible Project" },
    });
    const project = createRes.json();

    await createUser("sysadmin@example.com", "SYSTEM_ADMIN");
    const sysadminCookie = await loginAs(app, "sysadmin@example.com");

    const getRes = await app.inject({
      method: "GET",
      url: `/projects/${project.id}`,
      headers: { cookie: sysadminCookie },
    });
    expect(getRes.statusCode).toBe(200);
  });

  it("blocks a plain MEMBER from managing the project (e.g. archiving it), but allows the OWNER", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Managed Project" },
    });
    const project = createRes.json();

    const member = await createUser("member@example.com", "HR_USER");
    const memberCookie = await loginAs(app, "member@example.com");
    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/members`,
      headers: { cookie: ownerCookie },
      payload: { userId: member.id, role: "MEMBER" },
    });

    await app.inject({
      method: "POST",
      url: `/projects/${project.id}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "ACTIVE" },
    });

    const memberArchiveRes = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/status`,
      headers: { cookie: memberCookie },
      payload: { status: "ARCHIVED" },
    });
    expect(memberArchiveRes.statusCode).toBe(403);

    const ownerArchiveRes = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/status`,
      headers: { cookie: ownerCookie },
      payload: { status: "ARCHIVED" },
    });
    expect(ownerArchiveRes.statusCode).toBe(200);
  });

  it("scopes the project list server-side: HR_USER sees only their projects, HR_ADMIN sees all", async () => {
    await createUser("owner@example.com", "HR_USER");
    const ownerCookie = await loginAs(app, "owner@example.com");
    await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie: ownerCookie },
      payload: { title: "Owner's Project" },
    });

    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");
    const outsiderList = await app.inject({ method: "GET", url: "/projects", headers: { cookie: outsiderCookie } });
    expect(outsiderList.json()).toEqual([]);

    await createUser("admin@example.com", "HR_ADMIN");
    const adminCookie = await loginAs(app, "admin@example.com");
    const adminList = await app.inject({ method: "GET", url: "/projects", headers: { cookie: adminCookie } });
    expect(adminList.json()).toHaveLength(1);
  });
});
