import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// One config row per AI task (architecture doc: "DB-driven, no redeploy
// needed to switch models"). All point at Claude for V1 (Decision 3); a
// future provider only needs a new row + adapter registration, not a schema
// change.
const TASK_DEFAULTS: { taskType: string; promptVersion: string; maxTokens: number }[] = [
  { taskType: "REQUIREMENT_INTERPRETATION", promptVersion: "v1", maxTokens: 4096 },
  { taskType: "WEIGHTING_RECOMMENDATION", promptVersion: "v1", maxTokens: 4096 },
  { taskType: "RESUME_INTELLIGENCE", promptVersion: "v1", maxTokens: 8192 },
  { taskType: "REQUIREMENT_EVIDENCE_ANALYSIS", promptVersion: "v1", maxTokens: 8192 },
  { taskType: "CAREER_CONSISTENCY_ANALYSIS", promptVersion: "v1", maxTokens: 4096 },
  { taskType: "CANDIDATE_COMPARISON", promptVersion: "v1", maxTokens: 4096 },
];

async function main() {
  for (const task of TASK_DEFAULTS) {
    await prisma.aiModelConfiguration.upsert({
      where: { taskType: task.taskType as never },
      update: {},
      create: {
        taskType: task.taskType as never,
        provider: "claude",
        model: "claude-sonnet-5",
        temperature: 0.2,
        maxTokens: task.maxTokens,
        timeoutMs: 60_000,
        retryPolicy: { maxRetries: 1 },
        promptVersion: task.promptVersion,
        isActive: true,
      },
    });
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@example.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "change-me-immediately";
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: "System Admin",
      role: "SYSTEM_ADMIN",
      passwordHash: await bcrypt.hash(adminPassword, 12),
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded ${TASK_DEFAULTS.length} AI task configs and admin user ${adminEmail}.`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
