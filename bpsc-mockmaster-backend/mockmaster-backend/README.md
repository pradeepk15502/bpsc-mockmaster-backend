# BPSC MockMaster — production backend (release candidate 1)

The server side of the approved MockMaster prototype. The product, cohort model and Generate → Review → Validate → Publish workflow are unchanged (architecture frozen). What changed is where the authority lives: **payment, entitlement, timer, score, correct answers, permissions and exam access are decided only on the server.**

> Status: backend complete and tested; **not yet connected to the student/admin frontend**. See *Launch blockers* below before taking real payments.

## Stack

| Part | Choice | Why |
|---|---|---|
| API | Node 22, TypeScript, Fastify 5 (modular monolith) | small, fast, strict typing; no microservices |
| Database | PostgreSQL 14+ with plain SQL migrations (`src/db/migrations`) | constraints do real work (uniqueness, PYQ provenance, append-only audit). Prisma was not used because its engine binaries could not be installed in the build environment; the schema can be introspected with `prisma db pull` if you want Prisma later |
| Queue / cache | Redis 7 + BullMQ | generation jobs, attempt expiry, reconciliation, daily planner, rate limits |
| Worker | separate process (`dist/src/worker.js`) | the only code that calls Claude |
| Payments | Razorpay Orders + Checkout + webhooks + reconciliation | |
| OTP | MSG91 Flow API (DLT template); console adapter for development only | |
| Validation | Zod on every request body / query / param | |

## Run it

```bash
cp .env.example .env            # fill in every value
docker compose up -d postgres redis
npm ci
npm run migrate
npm run seed:reference          # configs (all PENDING_VERIFICATION), syllabus, languages, blueprints, prices (all inactive)
ADMIN_NAME="..." ADMIN_EMAIL="..." ADMIN_PASSWORD="12+ chars" npm run create-admin
npm run dev                     # API on :8080
npm run dev:worker              # worker
```

Production: `npm run build`, then run `node dist/src/db/migrate.js`, `node dist/src/server.js` (API, scale horizontally) and `node dist/src/worker.js` (1+ replicas). The Dockerfile builds one image for both. The app **refuses to start in production** with console OTP, `rzp_test_` keys, a non-https origin, or missing legal / support details.

Tests (start their own throwaway PostgreSQL 16 and redis-server; nothing at the DB/queue level is mocked):

```bash
npm test          # needs postgres binaries (initdb/pg_ctl) and redis-server on the machine
```

## How the P0 rules are enforced

**Server-authoritative timer.** `POST /api/attempts` stores `server_started_at` / `server_expires_at` (duration from the mock's frozen config). Every attempt response carries `serverStartedAt`, `serverExpiresAt`, `serverNow`, `remainingSeconds`; the browser countdown is display-only. A delayed BullMQ job at expiry plus a 15-second sweeper turn `IN_PROGRESS → AUTO_SUBMITTED` even if the browser is closed; every read of an expired attempt also finalises it. Saves after expiry (+3 s network grace) are refused with `TIME_UP`. An attempt started before the plan expired can be completed.

**Answer versioning.** Each save carries `version`; the upsert only applies when `stored.version < new.version`, so a late old request is ignored atomically. The browser queue (`client/answer-queue.ts`) keeps answers in localStorage, retries with backoff, flushes on `online`, and reconciles with the server's `serverVersion` per answer. Versions are `max(previous + 1, wall-clock ms)` so the later change wins across tabs.

**Atomic, idempotent submit.** Submit, auto-submit and the sweeper all go through one function that row-locks the attempt; the second caller gets the stored result. Answer saves take a shared lock, so they can never race a submit. One attempt per student per mock is a unique constraint.

**Question security.** `GET /api/attempts/:id/paper` returns only text, options (configured keys only), position and section. No correct option, explanation, option reasons, concept, tip, provenance or internal question ids. Answers are addressed by position. Correct answers and explanations come only from `/result` and `/review` after submission. Scores are computed from the mock's frozen snapshot (`mock_questions.frozen`), never from live questions.

**Payments.** Order → Checkout → `POST /api/payments/verify` (HMAC of `order_id|payment_id`, then the server fetches the payment from Razorpay and requires `captured` with matching order, amount and currency) → entitlement. Webhooks are signature-checked over the raw body, deduplicated by `X-Razorpay-Event-Id` (primary key) and processed in the same transaction as the insert. Entitlements are created only in `finalizePayment`, guarded by unique `purchases.payment_id` and `entitlements(payment_id, cohort_base)`. The reconciliation worker (every 5 min) settles CREATED / PENDING (and recently FAILED) payments against the Razorpay API, captures authorised ones and expires abandoned checkouts. Refunds: admin endpoint (FINANCE / SUPER) or `refund.processed` webhook; access revoked per policy; everything audited.

**Authentication.** 6-digit OTP from a CSPRNG, stored as an HMAC, 5-minute expiry, 5 wrong tries lock the code, 60-second resend cooldown, per-mobile and per-IP limits on request and verify, never returned by the API. Sessions are random 256-bit tokens stored hashed, in `HttpOnly; Secure; SameSite=Lax` cookies, 30-day absolute / 7-day idle (admins 12 h / 1 h), revocable, with a double-submit CSRF token required on every state-changing request. Admin login uses scrypt with lockout after 5 failures.

**Authorization.** Every student query is scoped by `user_id`; another student's attempt / payment / entitlement returns the same 404 as a missing one. Admin routes check a server-side permission table (`src/modules/rbac.ts`); question state transitions re-check the actor's role (a QUESTION_REVIEWER can review and validate but cannot publish).

**Rate limits** (Redis, `src/lib/ratelimit.ts`): OTP request / verify, admin login, payment create / verify, attempt start, answer save, heartbeat, submit, events, public catalog, support form, admin API, generation, webhook.

**Exam configuration verification.** Configs carry `exam_type`, `version`, `source_document`, `source_url`, `verified_by`, `verified_at`, `verification_status`. A database CHECK makes `OFFICIALLY_VERIFIED` impossible without all four source fields. Workflow: a CONTENT / SUPER admin submits the official document + URL; a *different* SUPER_ADMIN verifies against the same source (four-eyes). Verified configs cannot be edited or downgraded — changes create a new version. The catalog shows an official pattern only for verified configs; Official Pattern mocks cannot be sold, created or published on unverified configs. Seeded configs are all `PENDING_VERIFICATION` (they came from the product brief, not an official notification).

**Content availability gate.** A cohort (exam, level/paper, subject, TRE language, config) can be sold only if *all* hold: sale switched on by a SUPER_ADMIN, usable config whose verification allows the sale mode, active language and subject, compliant blueprint, enough reviewed + published bank questions for every blueprint rule × `minReadyMocks` (setting, default 7), and an active price. Otherwise students see *Coming soon / Join waitlist* and order creation is refused before Razorpay is called. The sale switch itself refuses to turn on until the checks pass.

**Generation.** Admin → job (idempotent per cohort + date) → BullMQ → worker. Reviewed bank questions not yet used in the cohort are reused first; the rest go to Claude in batches with forced tool output, Zod schema validation, slot / syllabus / option-set checks, 3 tries with exponential backoff, per-batch token accounting and a daily token budget. Partial failures keep good batches; *retry failed batches* re-runs only those. AI output is always stored as `AI_GENERATED` with no exam / year (also enforced by a CHECK constraint). Claude is never called on test open, submit, result or explanation.

**Legal / support.** `/legal/terms`, `/legal/privacy`, `/legal/refund`, `/legal/contact`, `/legal/delete-account`; support form (works signed out); data export; deletion request → admin completion (anonymises the user, revokes sessions, keeps payment records). Pages show “pending legal review” until `LEGAL_REVIEWED=true`.

## Launch blockers (not solvable in code)

See `docs/LAUNCH_CHECKLIST.md`. In short: connect the frontend; verify at least one exam configuration against the official BPSC document (or consciously launch it as a practice configuration); build and review the question bank for the launch cohort; live MSG91 (DLT template) and Razorpay credentials + webhook; lawyer review of the legal pages and the refund window; production infrastructure (managed Postgres with backups, Redis with persistence, TLS, secrets manager, monitoring); real-device mobile testing.

## Layout

```
src/
  app.ts, server.ts, worker.ts, bootstrap.ts, queues.ts, config.ts
  adapters/   msg91 + console OTP, Razorpay HTTP client + signature checks, Claude generator
  domain/     validator (23 checks), scoring, Claude JSON contract, shared types
  modules/    auth, sessions, rbac, catalog (config workflow + availability gate), payments,
              content-core / content (generation, review, validation, publish), attempts, account, admin, legal
  db/         migrations, migrate runner, reference seed
client/       answer-queue.ts (browser offline queue + display timer helper)
test/         107 tests against real PostgreSQL + Redis + BullMQ
docs/         API.md, LAUNCH_CHECKLIST.md
```
