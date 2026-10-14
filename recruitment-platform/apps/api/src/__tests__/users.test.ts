import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

describe("POST /users — admin-only account creation", () => {
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

  function postUsers(cookie: string | null, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/users",
      headers: cookie ? { cookie } : {},
      payload,
    });
  }

  it("1. rejects an unauthenticated request", async () => {
    const res = await postUsers(null, { email: "new@example.com", name: "New Person", password: "password123" });
    expect(res.statusCode).toBe(401);
  });

  it("2. HR_USER cannot create users", async () => {
    await createUser("plain@example.com", "HR_USER");
    const cookie = await loginAs(app, "plain@example.com");
    const res = await postUsers(cookie, { email: "new@example.com", name: "New Person", password: "password123" });
    expect(res.statusCode).toBe(403);
  });

  it("3. HR_ADMIN cannot create a SYSTEM_ADMIN", async () => {
    await createUser("hradmin@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin@example.com");
    const res = await postUsers(cookie, {
      email: "newsysadmin@example.com",
      name: "Aspiring Admin",
      password: "password123",
      role: "SYSTEM_ADMIN",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("role_not_authorized");
    const created = await prisma.user.findUnique({ where: { email: "newsysadmin@example.com" } });
    expect(created).toBeNull();
  });

  it("4. SYSTEM_ADMIN can create a SYSTEM_ADMIN", async () => {
    await createUser("sysadmin@example.com", "SYSTEM_ADMIN");
    const cookie = await loginAs(app, "sysadmin@example.com");
    const res = await postUsers(cookie, {
      email: "newsysadmin2@example.com",
      name: "New Admin",
      password: "password123",
      role: "SYSTEM_ADMIN",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("SYSTEM_ADMIN");
  });

  it("5. authorized creation of an ordinary HR_USER succeeds", async () => {
    await createUser("hradmin2@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin2@example.com");
    const res = await postUsers(cookie, { email: "ordinary@example.com", name: "Ordinary User", password: "password123" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe("ordinary@example.com");
    expect(body.role).toBe("HR_USER");
  });

  it("5b. HR_ADMIN can create a peer HR_ADMIN account", async () => {
    await createUser("hradmin3@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin3@example.com");
    const res = await postUsers(cookie, {
      email: "peeradmin@example.com",
      name: "Peer Admin",
      password: "password123",
      role: "HR_ADMIN",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("HR_ADMIN");
  });

  it("6. rejects an invalid email with 400", async () => {
    await createUser("hradmin4@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin4@example.com");
    const res = await postUsers(cookie, { email: "not-an-email", name: "Bad Email", password: "password123" });
    expect(res.statusCode).toBe(400);
    const found = await prisma.user.findFirst({ where: { name: "Bad Email" } });
    expect(found).toBeNull();
  });

  it("7. duplicate email returns 409", async () => {
    await createUser("hradmin5@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin5@example.com");
    await postUsers(cookie, { email: "dupe@example.com", name: "First", password: "password123" });
    const res = await postUsers(cookie, { email: "dupe@example.com", name: "Second", password: "password123" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("email_already_exists");
  });

  it("8. an unrecognized role value is rejected (400), never silently downgraded to HR_USER", async () => {
    await createUser("hradmin6@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin6@example.com");
    const res = await postUsers(cookie, {
      email: "weirdrole@example.com",
      name: "Weird Role",
      password: "password123",
      role: "SUPERUSER",
    });
    expect(res.statusCode).toBe(400);
    const found = await prisma.user.findUnique({ where: { email: "weirdrole@example.com" } });
    expect(found).toBeNull();
  });

  it("9. the response never exposes passwordHash or the plaintext password", async () => {
    await createUser("hradmin7@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin7@example.com");
    const res = await postUsers(cookie, { email: "safe@example.com", name: "Safe User", password: "super-secret-pw" });
    expect(res.statusCode).toBe(201);
    const bodyText = JSON.stringify(res.json());
    expect(bodyText).not.toContain("passwordHash");
    expect(bodyText).not.toContain("super-secret-pw");
  });

  it("10. successful creation records an audit event without secrets", async () => {
    const admin = await createUser("hradmin8@example.com", "HR_ADMIN");
    const cookie = await loginAs(app, "hradmin8@example.com");
    const res = await postUsers(cookie, { email: "audited@example.com", name: "Audited User", password: "password123" });
    const newUserId = res.json().id;

    const entry = await prisma.auditLog.findFirst({ where: { action: "USER_CREATED", entityId: newUserId } });
    expect(entry).not.toBeNull();
    expect(entry?.actorId).toBe(admin.id);
    const afterText = JSON.stringify(entry?.afterJson);
    expect(afterText).not.toContain("password123");
    expect(afterText).not.toContain("passwordHash");
    expect(afterText).toContain("audited@example.com");
  });
});
