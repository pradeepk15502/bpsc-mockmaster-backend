# API reference

All bodies are JSON. Student routes use the `mm_sid` cookie; admin routes use `mm_asid`. Every POST/PUT/PATCH from a signed-in browser must send `X-CSRF-Token` (value of the `mm_csrf` / `mm_acsrf` cookie, also returned at sign-in). Errors look like `{ "error": { "code", "message", "details?" }, "requestId" }`; `message` is safe to show to people.

Auth column: `public`, `student`, `admin` (any signed-in admin) or `admin:<permission>` (see `src/modules/rbac.ts`).

| Method | Path | Auth |
|---|---|---|
| GET | `/api/account/deletion-request` | student |
| POST | `/api/account/deletion-request` | student |
| GET | `/api/account/export` | student |
| POST | `/api/admin/admins` | admin:admin.manage |
| GET | `/api/admin/audit` | admin:audit.view |
| POST | `/api/admin/auth/login` | public |
| POST | `/api/admin/auth/logout` | admin |
| POST | `/api/admin/availability` | admin:config.view |
| POST | `/api/admin/configs` | admin:config.edit |
| GET | `/api/admin/configs` | admin:config.view |
| POST | `/api/admin/configs/:id/activate` | admin:config.edit |
| POST | `/api/admin/configs/:id/mark-practice` | admin:config.verify |
| POST | `/api/admin/configs/:id/submit-verification` | admin:config.submit |
| POST | `/api/admin/configs/:id/verify` | admin:config.verify |
| GET | `/api/admin/deletion-requests` | admin:deletion.process |
| POST | `/api/admin/deletion-requests/:id/complete` | admin:deletion.process |
| GET | `/api/admin/jobs/:id` | admin:mock.view |
| POST | `/api/admin/jobs/:id/retry-failed` | admin:question.generate |
| GET | `/api/admin/me` | admin |
| POST | `/api/admin/mocks` | admin:mock.manage |
| GET | `/api/admin/mocks` | admin:mock.view |
| GET | `/api/admin/mocks/:id` | admin:mock.view |
| POST | `/api/admin/mocks/:id/close` | admin:mock.manage |
| POST | `/api/admin/mocks/:id/generate` | admin:question.generate |
| POST | `/api/admin/mocks/:id/process` | admin:question.review |
| POST | `/api/admin/mocks/:id/publish` | admin:mock.publish |
| POST | `/api/admin/mocks/:id/replace-question` | admin:mock.manage |
| POST | `/api/admin/mocks/:id/reuse-decision` | admin:mock.manage |
| POST | `/api/admin/mocks/:id/validate` | admin:mock.manage |
| GET | `/api/admin/notifications` | admin |
| GET | `/api/admin/payments` | admin:payment.view |
| POST | `/api/admin/payments/:id/refund` | admin:payment.refund |
| POST | `/api/admin/payments/reconcile` | admin:payment.reconcile |
| PUT | `/api/admin/questions/:id` | admin:question.edit |
| GET | `/api/admin/questions/:id` | admin:question.view |
| GET | `/api/admin/sales` | admin:config.view |
| PUT | `/api/admin/sales` | admin:sales.edit |
| GET | `/api/admin/students` | admin:student.view |
| POST | `/api/admin/students/:id/status` | admin:student.suspend |
| GET | `/api/admin/support` | admin:support.view |
| GET | `/api/admin/waitlist` | admin:waitlist.view |
| GET | `/api/attempts` | student |
| POST | `/api/attempts` | student |
| GET | `/api/attempts/:id` | student |
| PUT | `/api/attempts/:id/answers` | student |
| POST | `/api/attempts/:id/explanations` | student |
| POST | `/api/attempts/:id/heartbeat` | student |
| GET | `/api/attempts/:id/paper` | student |
| GET | `/api/attempts/:id/result` | student |
| GET | `/api/attempts/:id/review` | student |
| POST | `/api/attempts/:id/submit` | student |
| POST | `/api/auth/logout` | student |
| POST | `/api/auth/logout-all` | student |
| POST | `/api/auth/otp/request` | public |
| POST | `/api/auth/otp/verify` | public |
| GET | `/api/catalog` | public |
| POST | `/api/catalog/availability` | public |
| GET | `/api/entitlements` | student |
| PATCH | `/api/entitlements/:id` | student |
| POST | `/api/events` | student |
| GET | `/api/me` | student |
| PATCH | `/api/me` | student |
| GET | `/api/mocks/today` | student |
| GET | `/api/notifications` | student |
| POST | `/api/notifications/read-all` | student |
| GET | `/api/payments` | student |
| GET | `/api/payments/:id` | student |
| POST | `/api/payments/orders` | student |
| POST | `/api/payments/verify` | student |
| POST | `/api/support` | public |
| POST | `/api/waitlist` | student |
| POST | `/api/webhooks/razorpay` | public |
| GET | `/legal/contact` | public |
| GET | `/legal/delete-account` | public |
| GET | `/legal/privacy` | public |
| GET | `/legal/refund` | public |
| GET | `/legal/terms` | public |
| POST | `/api/admin/questions/:id/open` | admin:question.review |
| POST | `/api/admin/questions/:id/approve` | admin:question.review |
| POST | `/api/admin/questions/:id/reject` | admin:question.review |
| POST | `/api/admin/questions/:id/validate` | admin:question.validate |
| POST | `/api/admin/questions/:id/publish` | admin:question.publish |
| POST | `/api/admin/questions/:id/revise` | admin:question.edit |
| POST | `/api/admin/questions/:id/archive` | admin:question.edit |

## Student test flow (for the frontend)

1. `GET /api/mocks/today` → per plan: `state` = `available | resumable | attempted | unavailable | closed | blocked`.
2. `POST /api/attempts {mockId}` → `{attemptId, serverStartedAt, serverExpiresAt, serverNow, remainingSeconds, resumed}`. Same call resumes.
3. `GET /api/attempts/:id/paper` → `questions[{position, section, text{hi,en,hl}, options{A..}}]` (or `{position, unavailable:true}` — show “Question unavailable”, never substitute text).
4. Answers via `client/answer-queue.ts` → `PUT /api/attempts/:id/answers {answers:[{position, selected|null, marked, timeSpentSec, version}]}` → per item `{accepted, serverVersion}`. `409 TIME_UP` / `ALREADY_SUBMITTED` ends the test.
5. `POST /api/attempts/:id/heartbeat` every 30–60 s to re-sync the countdown (display only).
6. `POST /api/attempts/:id/submit {answers?}` (idempotent) → `/result`, `/review`, `POST /explanations {position, action}`.

## Purchase flow

1. `POST /api/catalog/availability {selection}` → `AVAILABLE` (with server price) or `COMING_SOON` (`canJoinWaitlist`) → `POST /api/waitlist`.
2. `POST /api/payments/orders {plan, parts[], questionLang, explanationLang, idempotencyKey}` → `checkout` options for Razorpay Checkout.
3. Checkout handler → `POST /api/payments/verify {paymentId, razorpay_order_id, razorpay_payment_id, razorpay_signature}` → `SUCCESS` or `PENDING`. On `PENDING`, poll `GET /api/payments/:id`; the webhook / reconciliation completes it. The frontend never activates anything.

Webhook: configure `https://<api>/api/webhooks/razorpay` in the Razorpay dashboard with events `payment.captured`, `order.paid`, `payment.failed`, `payment.authorized`, `refund.processed` and the secret in `RAZORPAY_WEBHOOK_SECRET`.
