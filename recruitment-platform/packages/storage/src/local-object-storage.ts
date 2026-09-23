import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ObjectStorage, PutObjectInput } from "./object-storage.js";

/**
 * Filesystem-backed adapter implementing the same ObjectStorage interface
 * as S3ObjectStorage — for local development/tests where standing up MinIO
 * isn't available or desired (e.g. this sandbox has no Docker daemon).
 * Never used as a production path; content type is not preserved on read
 * since the filesystem has no such concept, which is fine since nothing
 * downstream of getObject needs it (only parsing needs bytes).
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly name = "local";
  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    if (key.includes("..")) throw new Error(`Refusing unsafe storage key: ${key}`);
    return join(this.rootDir, key);
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async deleteObject(key: string): Promise<void> {
    await unlink(this.pathFor(key)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
}
