import { describe, expect, it } from "vitest";
import { canAccessProject, canManageProject } from "./project-authorization.js";

describe("canAccessProject", () => {
  it("lets an HR_USER access a project they are a member of", () => {
    expect(canAccessProject({ systemRole: "HR_USER", isProjectMember: true })).toBe(true);
  });

  it("blocks an HR_USER from a project they are not a member of", () => {
    expect(canAccessProject({ systemRole: "HR_USER", isProjectMember: false })).toBe(false);
  });

  it("lets HR_ADMIN access any project regardless of membership", () => {
    expect(canAccessProject({ systemRole: "HR_ADMIN", isProjectMember: false })).toBe(true);
  });

  it("lets SYSTEM_ADMIN access any project regardless of membership", () => {
    expect(canAccessProject({ systemRole: "SYSTEM_ADMIN", isProjectMember: false })).toBe(true);
  });
});

describe("canManageProject", () => {
  it("lets the project OWNER manage it", () => {
    expect(canManageProject({ systemRole: "HR_USER", projectRole: "OWNER" })).toBe(true);
  });

  it("blocks a plain MEMBER from managing it", () => {
    expect(canManageProject({ systemRole: "HR_USER", projectRole: "MEMBER" })).toBe(false);
  });

  it("blocks a non-member HR_USER from managing it", () => {
    expect(canManageProject({ systemRole: "HR_USER", projectRole: null })).toBe(false);
  });

  it("lets HR_ADMIN manage any project", () => {
    expect(canManageProject({ systemRole: "HR_ADMIN", projectRole: null })).toBe(true);
  });

  it("lets SYSTEM_ADMIN manage any project", () => {
    expect(canManageProject({ systemRole: "SYSTEM_ADMIN", projectRole: null })).toBe(true);
  });
});
