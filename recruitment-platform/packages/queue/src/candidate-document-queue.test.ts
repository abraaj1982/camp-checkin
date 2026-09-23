import { describe, expect, it } from "vitest";
import { FakeCandidateDocumentQueue } from "./candidate-document-queue.js";

describe("FakeCandidateDocumentQueue", () => {
  it("captures enqueued jobs in order without touching any real queue", async () => {
    const queue = new FakeCandidateDocumentQueue();
    await queue.enqueue({ candidateDocumentId: "d1", candidateId: "c1", projectId: "p1" });
    await queue.enqueue({ candidateDocumentId: "d2", candidateId: "c2", projectId: "p1" });

    expect(queue.enqueued).toEqual([
      { candidateDocumentId: "d1", candidateId: "c1", projectId: "p1" },
      { candidateDocumentId: "d2", candidateId: "c2", projectId: "p1" },
    ]);
  });
});
