# Recruitment Intelligence Platform

AI-powered evidence-based candidate assessment. Internal HR tool — see the
Phase 0 architecture proposal (linked from the project's Claude session) for
the full design.

This app is fully isolated from the `camp-checkin` files at the repo root:
own `package.json`/workspaces, own database, own deployment. Nothing at the
repo root is read, written, or depended on by anything in this directory.

## Status (Phase 1 — Foundation)

Implemented:
- Monorepo workspace layout (`apps/web`, `apps/api`, `worker`, `packages/*`)
- Prisma schema for the full data model (projects, requirements, candidates,
  evidence, assessments, decisions, overrides, audit log, AI config)
- `AIProvider` abstraction + `ClaudeProvider` + `AiGateway` (schema
  validation, retry-once, `AiInteraction` logging)
- Deterministic Experience Intelligence calculator (Total/Functional/
  Relevant/Directly-Relevant experience)
- Evidence Redaction Layer (V1 deterministic pass: direct identifiers +
  employer tokenization)
- Email/password auth behind an `AuthStrategy` abstraction, session-based,
  server-side RBAC (`HR_USER` / `HR_ADMIN` / `SYSTEM_ADMIN`)
- Audit log service (single write path, append-only)
- pg-boss queue skeleton + worker with per-candidate status tracking
- Basic Next.js UI shell (login page only)

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
