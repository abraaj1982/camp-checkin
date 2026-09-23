# Recruitment Intelligence Platform

AI-powered evidence-based candidate assessment. Internal HR tool — see the
Phase 0 architecture proposal (linked from the project's Claude session) for
the full design.

This app is fully isolated from the `camp-checkin` files at the repo root:
own `package.json`/workspaces, own database, own deployment. Nothing at the
repo root is read, written, or depended on by anything in this directory.

## Status (Phase 3 — Document & CV Engine)

Implemented in Phase 1 (Foundation):
- Monorepo workspace layout (`apps/web`, `apps/api`, `worker`, `packages/*`)
- `AIProvider` abstraction + `ClaudeProvider` + `AiGateway` (schema
  validation, retry-once, `AiInteraction` logging)
- Deterministic Experience Intelligence calculator (Total/Functional/
  Relevant/Directly-Relevant experience)
- Evidence Redaction Layer (V1 deterministic pass: direct identifiers +
  employer tokenization) — not yet wired into any route (no candidate data
  flows yet)
- Email/password auth behind an `AuthStrategy` abstraction, session-based,
  server-side RBAC (`HR_USER` / `HR_ADMIN` / `SYSTEM_ADMIN`)
- Audit log service (single write path, append-only)
- pg-boss queue skeleton + worker with per-candidate status tracking

Implemented in Phase 2 (Recruitment Project & Job Requirements):
- Project-level authorization (`ProjectMember`: OWNER/MEMBER), enforced
  server-side on every project-scoped route — an unrelated HR_USER gets 404,
  not 403, on a project they can't see
- Recruitment Project CRUD, status lifecycle (DRAFT → ACTIVE → ON_HOLD →
  READY_FOR_CV_UPLOAD → COMPLETED → ARCHIVED) with a deterministic
  allowed-transition table, HR user assignment
- Job Requirements CRUD with category/priority/mandatory, a
  Requirement Interpretation AI task producing semantic concepts
  (DIRECT/RELEVANT/PARTIALLY_RELEVANT/NOT_RELEVANT, each with a rationale)
  and structured evidence criteria
- AI Weighting recommendation (proposal only) + HR weight approval, with
  deterministic weight-total validation (must equal 100%) and an
  HR-note requirement when a weight diverges from the AI suggestion
- Requirement versioning: approving a requirement snapshots it into an
  immutable `JobRequirementVersion`; editing an approved requirement never
  overwrites that snapshot, only moves it to CHANGED pending re-approval
- Weighting Review UI (`/projects/:id/requirements`) with a "Why this
  weight?" panel showing the AI's interpretation, rationale, and evidence
  criteria per requirement — evidence-first, not a single score
- Full audit trail for every action above

Phase 2 hardening pass (closing gaps flagged in the Phase 2 completion
report, before Phase 3):
- Explicit `AssessmentEvidence` join (SUPPORTING / CONSIDERED_REJECTED,
  each with a rationale) — an assessment's supporting evidence is no longer
  inferred by matching candidateId+projectId+requirementId
- `Evidence`/`Assessment`/`HrDecision` → `Candidate` changed from
  cascade-delete to `onDelete: Restrict`: the database now refuses to
  hard-delete a candidate with any historical record, forcing a future
  purge to anonymize the `Candidate` row in place (`Candidate.piiPurgedAt`)
  rather than delete it — a candidate with no history can still be deleted
  normally
- `Evidence.sourceDocument` stays `onDelete: SetNull`: the original CV can
  be purged independently without touching the Evidence row that cites it
- `/candidates/:id/decisions` moved to `/projects/:projectId/candidates/:id/decisions`
  and now uses `requireProjectAccess()`, closing the one route that was
  inconsistent with the Phase 2 authorization model

Implemented in Phase 3 (Document & CV Engine):
- `ObjectStorage` abstraction (mirrors `AIProvider`): `S3ObjectStorage`
  (S3-compatible, works against the MinIO container in
  `infra/docker-compose.yml`) and `LocalObjectStorage` (filesystem, for
  local dev/tests without MinIO) — no application module imports an S3 SDK
  directly
- `CandidateDocumentQueue` abstraction over pg-boss (`packages/queue`),
  shared by the API (enqueues on upload) and the worker (consumes); a
  `FakeCandidateDocumentQueue` stands in for tests
- Batch CV upload (`POST /projects/:id/candidates/upload`, `@fastify/multipart`,
  up to 30 files): validates each file (extension + magic-number check, not
  just the declared MIME type), stores the *original, unmodified* bytes,
  creates `Candidate`/`CandidateProjectLink`/`CandidateDocument` rows, and
  enqueues one job per document — an invalid file is rejected and reported
  without failing the rest of the batch
- Real PDF (`pdfjs-dist`, page-by-page text) and DOCX (`mammoth`) parsing in
  the worker; a near-empty extraction is flagged `FAILED_NEEDS_OCR` rather
  than silently processed
- Resume Intelligence now actually runs through the existing `AiGateway` →
  `ClaudeProvider` (worker/src/pipeline.ts), persisting normalized
  `CandidateExperience`/`Education`/`Skill`/`Certification`/`Language` rows;
  invalid AI output never reaches those tables (existing schema validation)
- Extracted text and per-page text are preserved on `CandidateDocument`
  (`extractedText`, `extractedPageTexts`) independently of the original
  file, so Phase 4 can cite a source page without re-parsing and the
  original can later be purged under the retention policy without losing
  what was extracted from it
- Per-document retry (`POST .../documents/:id/retry`, only from
  `FAILED_RETRY`) and a Processing Status UI
  (`/projects/:id/candidates`) showing per-candidate, per-document status,
  polling while anything is in flight
- Full audit trail for upload, processing (success/OCR-needed/AI failure),
  and retry

Not yet implemented (later phases per the approved plan):
- Evidence extraction / semantic matching / career analysis AI calls
  (Phase 4) — Resume Intelligence (extraction) is done; Requirement
  Evidence Analysis and Career/Consistency Analysis are not
- Blind screening UI, Evidence Viewer, Candidate Comparison (Phase 5)
- HR decision UI, candidate database/reuse screens (Phases 6-7)
- OIDC/SAML SSO (interface is ready; no concrete strategy implemented)
- A people-picker for assigning HR users (Phase 2 ships an exact-email
  lookup via `GET /users?search=`, not a directory browser)
- OCR for scanned/image-only documents (`FAILED_NEEDS_OCR` is detected and
  reported, not processed)
- Candidate deduplication/reuse across projects (Section 26) — every upload
  creates a new `Candidate` row; a returning candidate isn't recognized

## Tests

- Unit tests (`packages/shared-types`, `packages/ai-gateway`,
  `packages/storage`, `packages/queue`): pure domain logic — Experience
  Intelligence, project authorization rules, weight-total validation,
  requirement version snapshotting, evidence redaction, file-upload
  validation, `LocalObjectStorage` byte round-tripping, the fake queue. No
  DB, no network.
- Integration tests (`apps/api`, `worker`): real Fastify routes via
  `app.inject()` and the real document-processing pipeline, both against a
  real Postgres database (never mocked) and a temp-dir `LocalObjectStorage`
  (never MinIO in tests), with the AI Gateway's Claude provider swapped for
  a canned `FakeAIProvider` — no live Claude API calls are made in tests.
  `worker/src/__tests__/queue-end-to-end.test.ts` goes one step further:
  it enqueues through the real `PgBossCandidateDocumentQueue` (the API's
  actual enqueue path) and consumes with a real pg-boss worker, proving the
  queue plumbing itself, not just the pipeline function in isolation. Run
  with:
  ```bash
  DATABASE_URL=postgresql://recruitment:recruitment@localhost:5433/recruitment_platform \
    npm run test -w @recruitment-platform/api
  DATABASE_URL=postgresql://recruitment:recruitment@localhost:5433/recruitment_platform \
    npm run test -w @recruitment-platform/worker
  ```
  Test files within each package share one database and reset it in
  `beforeEach`, so they run sequentially (`fileParallelism: false`) — do not
  parallelize them without giving each file its own database.

## Local development

```bash
cd recruitment-platform
cp .env.example .env          # fill in ANTHROPIC_API_KEY when ready to test AI calls
docker compose -f infra/docker-compose.yml up -d
npm install
npm run db:generate
npm run db:migrate
npm run --workspace @recruitment-platform/db seed
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:3000
npm run dev:worker
```

Default seeded login: `admin@example.com` / `change-me-immediately`
(override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) — change this
password before using anything beyond local development.
