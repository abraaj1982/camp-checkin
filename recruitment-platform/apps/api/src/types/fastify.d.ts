import "fastify";
import type { AuthenticatedIdentity } from "../modules/auth/strategy.js";

declare module "fastify" {
  interface Session {
    identity: AuthenticatedIdentity;
  }
}
