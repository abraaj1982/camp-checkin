import "fastify";
import type { RecruitmentProject, ProjectMember } from "@recruitment-platform/db";
import type { AuthenticatedIdentity } from "../modules/auth/strategy.js";

declare module "fastify" {
  interface Session {
    identity: AuthenticatedIdentity;
  }

  interface FastifyRequest {
    // Set by requireProjectAccess/requireProjectManage preHandlers.
    project?: RecruitmentProject;
    projectMembership?: ProjectMember | null;
  }
}
