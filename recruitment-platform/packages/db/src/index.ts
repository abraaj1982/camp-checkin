import { PrismaClient } from "@prisma/client";

// Single shared client per process; the API, worker, and any script import
// this instead of constructing their own PrismaClient.
declare global {
  // eslint-disable-next-line no-var
  var __rip_prisma__: PrismaClient | undefined;
}

export const prisma = global.__rip_prisma__ ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__rip_prisma__ = prisma;
}

export * from "@prisma/client";
