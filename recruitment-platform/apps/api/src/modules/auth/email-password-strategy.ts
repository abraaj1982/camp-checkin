import bcrypt from "bcryptjs";
import { prisma } from "@recruitment-platform/db";
import type { AuthStrategy, AuthenticatedIdentity } from "./strategy.js";

export class EmailPasswordStrategy implements AuthStrategy {
  readonly name = "email_password";

  async authenticate(credentials: Record<string, unknown>): Promise<AuthenticatedIdentity | null> {
    const email = String(credentials.email ?? "").toLowerCase().trim();
    const password = String(credentials.password ?? "");
    if (!email || !password) return null;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) return null;

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return null;

    return { userId: user.id, email: user.email, role: user.role };
  }

  static async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }
}
