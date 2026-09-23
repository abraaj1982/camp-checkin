import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { ObjectStorage, PutObjectInput } from "./object-storage.js";

/**
 * S3-compatible adapter — works against real AWS S3 or the MinIO container
 * in infra/docker-compose.yml (Decision 5: local/Docker for now, no
 * commitment to a production host yet). Private bucket, no public URLs
 * (Section 33) — this adapter never generates one; a signed download URL
 * is a separate concern for whichever route needs it, not built here since
 * no download route exists yet in Phase 3.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: {
    endpoint?: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    forcePathStyle?: boolean;
  }) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? "us-east-1",
      forcePathStyle: options.forcePathStyle ?? true, // required for MinIO
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Object storage returned no body for key: ${key}`);
    return Buffer.from(bytes);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
