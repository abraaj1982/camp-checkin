/**
 * Project-level authorization decision, kept as a pure function so it's
 * testable without a database (architecture doc Phase 2, Section 1). The
 * API route layer fetches the membership row(s) and role, then calls this
 * — it never inlines the decision itself, so the rule is defined in exactly
 * one place.
 *
 * Rule: SYSTEM_ADMIN and HR_ADMIN can reach every project (system-level
 * oversight, matches Phase 1's "hr_admin ... audit history: All"). An
 * ordinary HR_USER can reach a project only if they created it or were
 * explicitly assigned as a ProjectMember (OWNER or MEMBER).
 */
export type SystemRole = "HR_USER" | "HR_ADMIN" | "SYSTEM_ADMIN";
export type ProjectRole = "OWNER" | "MEMBER";

export interface ProjectAccessInput {
  systemRole: SystemRole;
  isProjectMember: boolean;
}

export function canAccessProject(input: ProjectAccessInput): boolean {
  if (input.systemRole === "HR_ADMIN" || input.systemRole === "SYSTEM_ADMIN") {
    return true;
  }
  return input.isProjectMember;
}

/**
 * Who may change a project's membership list / status / core fields.
 * Broader access (read) is governed by canAccessProject; mutating actions
 * are further restricted to the project OWNER or a system-level admin, so
 * an assigned MEMBER can work the requirements but not archive the project
 * or remove other members out from under the owner.
 */
export interface ProjectManageInput {
  systemRole: SystemRole;
  projectRole: ProjectRole | null;
}

export function canManageProject(input: ProjectManageInput): boolean {
  if (input.systemRole === "HR_ADMIN" || input.systemRole === "SYSTEM_ADMIN") {
    return true;
  }
  return input.projectRole === "OWNER";
}
