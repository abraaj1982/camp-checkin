# Recruitment Intelligence Platform

AI-powered evidence-based candidate assessment. Internal HR tool — see the
Phase 0 architecture proposal (linked from the project's Claude session) for
the full design.

This app is fully isolated from the `camp-checkin` files at the repo root:
own `package.json`/workspaces, own database, own deployment. Nothing at the
repo root is read, written, or depended on by anything in this directory.

## Status (Phase 2 — Recruitment Project & Job Requirements)

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

Not yet implemented (later phases per the approved plan):
- PDF/DOCX parsing and the real document-processing pipeline (Phase 3)
- Evidence extraction / semantic matching / career analysis AI calls wired
  into the worker (Phase 4) — the pipeline function exists and fails loudly
  rather than faking success (see `worker/src/pipeline.ts`)
- Blind screening UI, Evidence Viewer, Candidate Comparison (Phase 5)
- HR decision UI, candidate database/reuse screens (Phases 6-7)
- OIDC/SAML SSO (interface is ready; no concrete strategy implemented)
- Object storage wiring (MinIO container is in `infra/docker-compose.yml`;
  no upload code yet)
- A people-picker for assigning HR users (Phase 2 ships an exact-email
  lookup via `GET /users?search=`, not a directory browser)

## Tests

- Unit tests (`packages/shared-types`, `packages/ai-gateway`): pure domain
  logic — Experience Intelligence, project authorization rules, weight-total
  validation, requirement version snapshotting, evidence redaction. No DB,
  no network.
- Integration tests (`apps/api`): real Fastify routes via `app.inject()`
  against a real Postgres database (never mocked), with the AI Gateway's
  Claude provider swapped for a canned `FakeAIProvider` — no live Claude API
  calls are made in tests. Run with:
  ```bash
  DATABASE_URL=postgresql://recruitment:recruitment@localhost:5433/recruitment_platform \
    npm run test -w @recruitment-platform/api
  ```
  Test files share one database and reset it in `beforeEach`, so they run
  sequentially (`fileParallelism: false` in `apps/api/vitest.config.ts`) —
  do not parallelize them without giving each file its own database.

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
