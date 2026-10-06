# Controlled-launch checklist

Code-side P0 items are implemented and tested (see README). The items below cannot be closed in code; each one blocks taking real money.

## P0 — must be done before the first real payment

- [ ] **Frontend connected to this API.** The approved prototype UI still runs on its in-browser store. Wire it to `docs/API.md`: OTP sign-in, catalog / availability / waitlist, Razorpay Checkout + verify + pending polling, today's mock, test screen with `client/answer-queue.ts`, result / review, account deletion, legal links. Then re-run the prototype's screen tests against the real API.
- [ ] **One exam configuration decided.** Either verify it against the official BPSC notification (`submit-verification` by one admin, `verify` by a different SUPER_ADMIN), or consciously launch it as a *practice configuration* (`mark-practice`), which the app labels “not an official BPSC pattern”. All seeded configs are PENDING and cannot be sold.
- [ ] **Product decision: daily mock length.** Seed practice mode is 15 questions / 15 minutes per day. Decide short daily practice vs full length and say it on the pricing screen.
- [ ] **Question bank for the launch cohort.** Generate, review (open each AI question — see P1 below) and publish enough questions that `/api/admin/availability` shows no `INSUFFICIENT_REVIEWED_QUESTIONS` (default: 7 mocks' worth per blueprint rule). Then switch the sale on with `PUT /api/admin/sales`.
- [ ] **Prices.** Seeded prices are inactive. Confirm amounts and **whether you are GST-registered**: prices currently add 18 % tax (`tax_pct`). If you are not registered, set it to 0; if you are, you also need GST invoices (not built).
- [ ] **MSG91 live.** DLT-registered OTP template and sender ID; check that the template variable name matches `MSG91_OTP_VAR`; send a real OTP to a test phone.
- [ ] **Razorpay live.** Live keys, webhook URL + secret with events `payment.captured, order.paid, payment.failed, payment.authorized, refund.processed`; one real ₹1-style payment and one refund end to end. Razorpay also reviews the legal pages before activating a live account.
- [ ] **Legal review.** A lawyer reviews `/legal/*`, the refund window (`REFUND_WINDOW_DAYS`, default 7 — a business decision) and the DPDP consent wording; fill the legal-entity, address, support and grievance-officer env values; then set `LEGAL_REVIEWED=true`.
- [ ] **Infrastructure.** Managed PostgreSQL with automated backups + a tested restore, Redis with persistence, HTTPS (TLS) in front of the API, secrets in a secrets manager (not a file), `TRUST_PROXY` set to the real number of proxies, at least one worker replica always running, first SUPER_ADMIN created with `npm run create-admin` and a second SUPER_ADMIN for four-eyes config verification.
- [ ] **Real-device mobile pass.** Low-end Android on slow 4G: sign-in, payment, test screen (offline + refresh), result.

## P1 — soon after launch

- Require each AI-generated question to be opened by a reviewer before approval (bulk “Process Questions” can currently approve without opening — the audit's item 16).
- “Report this question” + admin queue + audited “correct key and rescore affected attempts”.
- Scheduled publish time (“publish at 6:00 AM”) for approved mocks.
- Missed-mock rule (past mocks available during the plan?) and a free sample mock.
- SMS / WhatsApp notification when today's mock is published (in-app only today).
- Error tracking and alerting (Sentry or similar) on payment-verification failures, webhook signature failures, generation failures and submit errors. Logs are structured JSON (pino) with secrets redacted.
- Load test the morning peak (2k concurrent submits, answer saves); consider buffering in-progress answers in Redis.
- Admin two-factor authentication (TOTP); admin password reset flow.
- Partial refunds (recorded but access unchanged today); GST invoices if registered.
- Rupee-denominated generation cost cap (today: daily token budget).
- Docker image / compose file are provided but were not built in this environment.
