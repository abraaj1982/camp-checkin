import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalObjectStorage } from "./local-object-storage.js";
import { buildCandidateDocumentKey } from "./object-storage.js";

describe("LocalObjectStorage", () => {
  let dir: string;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "rip-storage-test-"));
    storage = new LocalObjectStorage(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes exactly", async () => {
    const key = "projects/p1/candidates/c1/documents/d1.pdf";
    const body = Buffer.from("%PDF-1.4 fake content");
    await storage.putObject({ key, body, contentType: "application/pdf" });
    const readBack = await storage.getObject(key);
    expect(readBack.equals(body)).toBe(true);
  });

  it("deletes an object", async () => {
    const key = "projects/p1/candidates/c1/documents/d1.pdf";
    await storage.putObject({ key, body: Buffer.from("x"), contentType: "application/pdf" });
    await storage.deleteObject(key);
    await expect(storage.getObject(key)).rejects.toThrow();
  });

  it("deleting a missing object does not throw", async () => {
    await expect(storage.deleteObject("never/existed.pdf")).resolves.toBeUndefined();
  });

  it("refuses a key containing a path traversal segment", async () => {
    await expect(
      storage.putObject({ key: "../../etc/passwd", body: Buffer.from("x"), contentType: "text/plain" }),
    ).rejects.toThrow(/unsafe storage key/);
  });
});

describe("buildCandidateDocumentKey", () => {
  it("builds a deterministic, unique-per-document key", () => {
    const key = buildCandidateDocumentKey({
      projectId: "proj-1",
      candidateId: "cand-1",
      documentId: "doc-1",
      fileExtension: "pdf",
    });
    expect(key).toBe("projects/proj-1/candidates/cand-1/documents/doc-1.pdf");
  });
});
