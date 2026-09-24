/**
 * The one storage interface every module uses — mirrors the AIProvider
 * pattern (architecture doc, Section: AI Provider Abstraction) applied to
 * document storage: no application module imports an S3/MinIO SDK directly,
 * only the concrete adapters in this package do. Originals are immutable —
 * nothing in this interface supports overwriting an existing key, only
 * put (once), get, and delete (retention purge, Phase 7+).
 */
export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  readonly name: string;
  putObject(input: PutObjectInput): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}

/**
 * Deterministic, collision-safe storage key for one candidate document.
 * Kept as a pure function (not inlined at call sites) so both the upload
 * route and any future retention job build the same key shape.
 */
export function buildCandidateDocumentKey(params: {
  projectId: string;
  candidateId: string;
  documentId: string;
  fileExtension: string;
}): string {
  return `projects/${params.projectId}/candidates/${params.candidateId}/documents/${params.documentId}.${params.fileExtension}`;
}

/**
 * Phase 7 — a StagedUpload has no candidateId yet (identity is resolved
 * AFTER storage, before any CandidateDocument exists), so it cannot use
 * buildCandidateDocumentKey's shape. storageKey is treated as an opaque
 * string everywhere in this codebase (never parsed, only ever passed back
 * to getObject) — so a promoted CandidateDocument keeping this key's shape
 * permanently (Phase 7A: no copy, no move) is safe by construction.
 */
export function buildStagedUploadKey(params: {
  projectId: string;
  stagedUploadId: string;
  fileExtension: string;
}): string {
  return `projects/${params.projectId}/staged-uploads/${params.stagedUploadId}.${params.fileExtension}`;
}
