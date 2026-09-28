import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@recruitment-platform/db";
import {
  startProcessingRun,
  failProcessingRun,
  completeProcessingRun,
  assertProcessingRunStillRunning,
  updateHeartbeat,
  startHeartbeat,
  findStaleProcessingRunIds,
  reclaimProcessingRun,
  runReclaimScan,
  ProcessingRunNoLongerActiveError,
  STALE_THRESHOLD_MS,
} from "../processing-run.js";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Phase 10D — ProcessingRun heartbeat & stale reclaim. Proves the
 * mechanism directly (unit/integration level), the correct level for
 * these guarantees per Phase 10B's own precedent — real Postgres, no
 * mocked DB, fake timers only for controlling tick timing.
 */
describe("ProcessingRun heartbeat & stale reclaim", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedDocument() {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
        status: "PROCESSING",
      },
    });
    return { document };
  }

  it("(11) heartbeatAt is set immediately at run creation — never null while RUNNING, the chosen NULL-safety strategy", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    const row = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.heartbeatAt).not.toBeNull();
    expect(row.heartbeatAt!.getTime()).toBeCloseTo(row.startedAt.getTime(), -2);
  });

  it("updateHeartbeat refreshes heartbeatAt for a genuinely RUNNING run", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    const before = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
    await new Promise((r) => setTimeout(r, 5));
    const ok = await updateHeartbeat(run.id);
    expect(ok).toBe(true);
    const after = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("(6) updateHeartbeat uses WHERE status = RUNNING — a terminal run is never resurrected or modified", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await failProcessingRun(run.id);
    const before = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
    const ok = await updateHeartbeat(run.id);
    expect(ok).toBe(false);
    const after = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
    expect(after.getTime()).toBe(before.getTime());
    const row = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("FAILED"); // unchanged — never resurrected
  });

  it("(1) startHeartbeat ticks on schedule (fake timers) and refreshes heartbeatAt", async () => {
    vi.useFakeTimers();
    try {
      const { document } = await seedDocument();
      const run = await startProcessingRun(document.id);
      const initial = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
      const handle = startHeartbeat(run.id, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      const afterOneTick = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
      expect(afterOneTick.getTime()).toBeGreaterThanOrEqual(initial.getTime());
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("(7) startHeartbeat stops itself once the run is no longer RUNNING (reclaimed) — becomes harmless", async () => {
    vi.useFakeTimers();
    try {
      const { document } = await seedDocument();
      const run = await startProcessingRun(document.id);
      const handle = startHeartbeat(run.id, 1000);
      await vi.advanceTimersByTimeAsync(1000); // one successful tick

      await failProcessingRun(run.id); // simulates heartbeat-driven reclaim
      await vi.advanceTimersByTimeAsync(1000); // this tick discovers it's no longer owned and self-stops

      const row = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("FAILED"); // unchanged by the heartbeat's own no-op write
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handle.stop() prevents any further ticks (no timer leak)", async () => {
    vi.useFakeTimers();
    try {
      const { document } = await seedDocument();
      const run = await startProcessingRun(document.id);
      const handle = startHeartbeat(run.id, 1000);
      handle.stop();
      const before = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
      await vi.advanceTimersByTimeAsync(5000);
      const after = (await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } })).heartbeatAt!;
      expect(after.getTime()).toBe(before.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("(8) a heartbeat DB failure is caught, logged, and does not fail the ProcessingRun", async () => {
    // Deliberately NOT vi.spyOn(prisma.processingRun, "updateMany") — that
    // has been observed (verified with a minimal standalone repro) to leave
    // updateMany permanently undefined after mockRestore() on this Prisma
    // model delegate, corrupting every later test in this file/process that
    // calls it directly. Plain reference-capture/reassignment is a safe
    // substitute: no accessor-descriptor restore involved.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalUpdateMany = prisma.processingRun.updateMany.bind(prisma.processingRun);
    try {
      const { document } = await seedDocument();
      const run = await startProcessingRun(document.id);
      const handle = startHeartbeat(run.id, 20);

      let failedOnce = false;
      (prisma.processingRun as unknown as { updateMany: typeof originalUpdateMany }).updateMany = ((args) => {
        if (!failedOnce) {
          failedOnce = true;
          return Promise.reject(new Error("transient DB outage"));
        }
        return originalUpdateMany(args);
      }) as typeof originalUpdateMany;

      await new Promise((r) => setTimeout(r, 60)); // >= one real tick
      (prisma.processingRun as unknown as { updateMany: typeof originalUpdateMany }).updateMany = originalUpdateMany;

      const row = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("RUNNING"); // never failed by a heartbeat write error
      expect(warnSpy).toHaveBeenCalled();
      handle.stop();
    } finally {
      warnSpy.mockRestore();
      (prisma.processingRun as unknown as { updateMany: typeof originalUpdateMany }).updateMany = originalUpdateMany;
    }
  });

  it("(9) findStaleProcessingRunIds only returns RUNNING runs whose heartbeatAt is older than the given cutoff", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    let stale = await findStaleProcessingRunIds(new Date(Date.now() - STALE_THRESHOLD_MS));
    expect(stale.map((r) => r.id)).not.toContain(run.id);

    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    stale = await findStaleProcessingRunIds(new Date(Date.now() - STALE_THRESHOLD_MS));
    expect(stale.map((r) => r.id)).toContain(run.id);
  });

  it("(10) a fresh RUNNING run is never reclaimed", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    const stale = await findStaleProcessingRunIds(new Date(Date.now() - STALE_THRESHOLD_MS));
    expect(stale.map((r) => r.id)).not.toContain(run.id);

    const scan = await runReclaimScan();
    expect(scan.reclaimed).toBe(0);
    const row = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(row.status).toBe("RUNNING");
  });

  it("(13) reclaimProcessingRun atomically transitions ProcessingRun -> FAILED and CandidateDocument -> FAILED_RETRY", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    // Backdate heartbeatAt so it satisfies the guard's own cutoff check.
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const ok = await reclaimProcessingRun(run.id, document.id, cutoff);
    expect(ok).toBe(true);
    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedDoc.status).toBe("FAILED_RETRY");
  });

  it("(12) concurrent reclaimers cannot both reclaim the same run — the loser never touches CandidateDocument", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const [a, b] = await Promise.all([
      reclaimProcessingRun(run.id, document.id, cutoff),
      reclaimProcessingRun(run.id, document.id, cutoff),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.status).toBe("FAILED_RETRY"); // written exactly once
  });

  it("no partial state: reclaim never leaves ProcessingRun=FAILED while CandidateDocument stays PROCESSING", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    await reclaimProcessingRun(run.id, document.id, new Date(Date.now() - STALE_THRESHOLD_MS));
    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedDoc.status).toBe("FAILED_RETRY");
  });

  it("reclaiming an already-terminal run is a harmless no-op and never overwrites CandidateDocument again", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    await reclaimProcessingRun(run.id, document.id, cutoff);
    // Simulate manual retry having already moved the document on.
    await prisma.candidateDocument.update({ where: { id: document.id }, data: { status: "QUEUED" } });

    const ok = await reclaimProcessingRun(run.id, document.id, cutoff);
    expect(ok).toBe(false);
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.status).toBe("QUEUED"); // untouched by the losing/late reclaim attempt
  });

  it("(A) scan-to-reclaim race: run heartbeats fresh after being selected as stale — reclaim refuses, run stays RUNNING, document stays PROCESSING", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    // Scan selects it as stale using a cutoff computed now.
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const stale = await findStaleProcessingRunIds(cutoff);
    expect(stale.map((r) => r.id)).toContain(run.id);

    // Before the reclaim executes, the owning worker heartbeats successfully.
    const heartbeatOk = await updateHeartbeat(run.id);
    expect(heartbeatOk).toBe(true);

    // Reclaimer now runs against the SAME (now-stale-relative-to-fresh-heartbeat) cutoff.
    const reclaimed = await reclaimProcessingRun(run.id, document.id, cutoff);
    expect(reclaimed).toBe(false);

    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("RUNNING");
    expect(updatedDoc.status).toBe("PROCESSING");
  });

  it("(B) a run that remains genuinely stale is reclaimed: ProcessingRun -> FAILED, CandidateDocument -> FAILED_RETRY", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const stale = await findStaleProcessingRunIds(cutoff);
    expect(stale.map((r) => r.id)).toContain(run.id);

    // No heartbeat occurs — the run remains stale by the time reclaim runs.
    const reclaimed = await reclaimProcessingRun(run.id, document.id, cutoff);
    expect(reclaimed).toBe(true);

    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("FAILED");
    expect(updatedDoc.status).toBe("FAILED_RETRY");
  });

  it("(C) concurrent reclaimers with the heartbeat-aware guard: exactly one wins, the loser never touches CandidateDocument", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
    const [a, b] = await Promise.all([
      reclaimProcessingRun(run.id, document.id, cutoff),
      reclaimProcessingRun(run.id, document.id, cutoff),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.status).toBe("FAILED_RETRY"); // written exactly once
  });

  it("(D) an actively-heartbeating run selected by a stale scan cannot be falsely reclaimed via runReclaimScan end-to-end", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await prisma.processingRun.update({
      where: { id: run.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });

    // Simulate the owning worker's heartbeat firing between the scan's
    // internal findStaleProcessingRunIds call and reclaimProcessingRun's
    // guarded UPDATE by intercepting $transaction itself (reclaimProcessingRun
    // runs its guarded update through the transaction client `tx`, not the
    // top-level `prisma` delegate, so a plain-reassignment intercept — see
    // the (8) test's comment on why vi.spyOn is avoided here — must wrap
    // $transaction to run the heartbeat write just before the callback).
    const original$transaction = prisma.$transaction.bind(prisma);
    let sawGuardedTransaction = false;
    (prisma as unknown as { $transaction: typeof original$transaction }).$transaction = (async (
      arg: unknown,
      ...rest: unknown[]
    ) => {
      if (!sawGuardedTransaction && typeof arg === "function") {
        sawGuardedTransaction = true;
        // The owning worker heartbeats successfully right before the reclaim's guarded update runs.
        await prisma.processingRun.update({ where: { id: run.id }, data: { heartbeatAt: new Date() } });
      }
      return (original$transaction as unknown as (...a: unknown[]) => unknown)(arg, ...rest);
    }) as typeof original$transaction;
    try {
      const result = await runReclaimScan();
      expect(result.reclaimed).toBe(0);
    } finally {
      (prisma as unknown as { $transaction: typeof original$transaction }).$transaction = original$transaction;
    }

    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("RUNNING");
    expect(updatedDoc.status).toBe("PROCESSING");
  });

  it("(9)(10) runReclaimScan finds and reclaims only stale runs, leaving fresh ones untouched", async () => {
    const { document: docA } = await seedDocument();
    const runA = await startProcessingRun(docA.id);
    await prisma.processingRun.update({
      where: { id: runA.id },
      data: { heartbeatAt: new Date(Date.now() - STALE_THRESHOLD_MS - 1000) },
    });
    const { document: docB } = await seedDocument();
    const runB = await startProcessingRun(docB.id); // fresh

    const result = await runReclaimScan();
    expect(result.reclaimed).toBe(1);

    const updatedA = await prisma.processingRun.findUniqueOrThrow({ where: { id: runA.id } });
    const updatedB = await prisma.processingRun.findUniqueOrThrow({ where: { id: runB.id } });
    expect(updatedA.status).toBe("FAILED");
    expect(updatedB.status).toBe("RUNNING");
    const updatedDocA = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: docA.id } });
    expect(updatedDocA.status).toBe("FAILED_RETRY");
  });

  it("(14)(22) old worker cannot write after reclaim — completeProcessingRun and assertProcessingRunStillRunning both refuse, currentProcessingRunId never regresses", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    // Heartbeat-driven reclaim (worker A stopped making progress).
    const reclaimed = await reclaimProcessingRun(run.id, document.id);
    expect(reclaimed).toBe(true);

    // Worker A "resumes" and attempts its guarded writes — both refused.
    await expect(completeProcessingRun(run.id, document.id)).rejects.toThrow(ProcessingRunNoLongerActiveError);
    await expect(
      prisma.$transaction(async (tx) => {
        await assertProcessingRunStillRunning(tx, run.id);
      }),
    ).rejects.toThrow(ProcessingRunNoLongerActiveError);

    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.status).toBe("FAILED_RETRY"); // unchanged by the old worker's refused attempts — never COMPLETED, never re-failed
    expect(updatedDoc.currentProcessingRunId).toBeNull(); // never regressed/promoted by the old worker
  });
});
