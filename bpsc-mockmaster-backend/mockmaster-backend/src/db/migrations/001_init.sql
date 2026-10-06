-- BPSC MockMaster — initial schema (PostgreSQL 14+)
-- Money is stored in paise (integer). Times are timestamptz (UTC); "today" for daily mocks uses TZ_EXAM.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- people & auth
CREATE SEQUENCE student_code_seq START 10001;
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_code  text NOT NULL UNIQUE DEFAULT ('STU-' || nextval('student_code_seq')),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  email         text,
  mobile        text UNIQUE CHECK (mobile ~ '^\+91[6-9][0-9]{9}$'),   -- NULL only after account deletion
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  ui_lang       text NOT NULL DEFAULT 'hl' CHECK (ui_lang IN ('hi','en','hl')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL AND status <> 'DELETED';

CREATE TABLE admin_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('SUPER_ADMIN','CONTENT_ADMIN','QUESTION_REVIEWER','FINANCE_ADMIN','SUPPORT_ADMIN')),
  status         text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_users_email_uq ON admin_users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('STUDENT','ADMIN')),
  subject_id   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_subject_idx ON sessions (subject_type, subject_id);

CREATE TABLE otp_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile      text NOT NULL,
  code_hash   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  ip          text
);
CREATE INDEX otp_requests_mobile_idx ON otp_requests (mobile, created_at DESC);

-- ---------------------------------------------------------------- configuration & syllabus
CREATE TABLE exam_configs (
  id                  text PRIMARY KEY,                 -- e.g. TRE_1112_V2
  exam_type           text NOT NULL CHECK (exam_type IN ('TRE','STET')),
  level               text,                             -- TRE: 1-5 | 6-8 | 9-10 | 11-12
  paper               text,                             -- STET: P1 | P2
  version             int  NOT NULL,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  option_count        int  NOT NULL CHECK (option_count IN (4,5)),
  duration_minutes    int,
  negative_marking    boolean NOT NULL DEFAULT false,
  sections            jsonb NOT NULL,                   -- [{id,name,kind,role,questionCount,marksPerQuestion,negativeMarks,qualifyingPercent,order,practiceCount,practiceQualifyingPercent}]
  practice            jsonb NOT NULL,                   -- {durationMinutes, negativeMarkingEnabled, negativeMarks, passPercent}
  pass_percent        numeric,
  verification_status text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (verification_status IN ('OFFICIALLY_VERIFIED','PENDING_VERIFICATION','PRACTICE_CONFIGURATION')),
  source_document     text,
  source_url          text,
  submitted_by        text,
  submitted_at        timestamptz,
  verified_by         text,
  verified_at         timestamptz,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((exam_type = 'TRE' AND level IS NOT NULL AND paper IS NULL) OR (exam_type = 'STET' AND paper IS NOT NULL AND level IS NULL)),
  CHECK (verification_status <> 'OFFICIALLY_VERIFIED' OR (source_document IS NOT NULL AND source_url IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)),
  UNIQUE (exam_type, level, paper, version)
);
-- At most one ACTIVE configuration per exam + level/paper.
CREATE UNIQUE INDEX exam_configs_one_active ON exam_configs (exam_type, COALESCE(level, ''), COALESCE(paper, '')) WHERE status = 'ACTIVE';

CREATE TABLE subjects (
  id           text PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  display_name text,
  active       boolean NOT NULL DEFAULT true,
  stet_papers  text[] NOT NULL DEFAULT '{}',
  tre_levels   text[] NOT NULL DEFAULT '{}',
  origin       text NOT NULL DEFAULT 'CATALOG' CHECK (origin IN ('CATALOG','ADMIN','OTHER_REQUEST')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE topics (
  id         text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  name       text NOT NULL,
  subtopics  text[] NOT NULL DEFAULT '{}',
  sort       int NOT NULL DEFAULT 0
);
CREATE TABLE tre_languages (
  code   text PRIMARY KEY,
  name   text NOT NULL,
  native text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort   int NOT NULL DEFAULT 0,
  levels text[] NOT NULL DEFAULT '{1-5,6-8,9-10,11-12}'
);
CREATE TABLE blueprints (
  id         text PRIMARY KEY,
  config_id  text NOT NULL REFERENCES exam_configs(id),
  subject_id text NOT NULL,                              -- syllabus subject id
  mode       text NOT NULL CHECK (mode IN ('PRACTICE','OFFICIAL')),
  difficulty jsonb NOT NULL,                             -- {EASY,MEDIUM,HARD} %
  rules      jsonb NOT NULL,                             -- [{sectionId,topic,subtopic,count}]
  UNIQUE (config_id, subject_id, mode)
);
CREATE TABLE other_subject_syllabus (
  other_key  text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(id),
  linked_by  text NOT NULL,
  linked_at  timestamptz NOT NULL DEFAULT now()
);

-- Launch-scope control: a cohort can be sold only when an admin enabled it AND the availability checks pass.
CREATE TABLE sale_controls (
  cohort_base text PRIMARY KEY,                          -- TRE|11-12|cs|hi  (exam|level-or-paper|subjectKey|treLang)
  mode        text NOT NULL DEFAULT 'PRACTICE' CHECK (mode IN ('PRACTICE','OFFICIAL')),
  enabled     boolean NOT NULL DEFAULT false,
  updated_by  text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
CREATE TABLE waitlist (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid REFERENCES users(id),
  cohort_base        text NOT NULL,
  selection          jsonb NOT NULL,
  other_subject_name text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  notified_at        timestamptz,
  UNIQUE (user_id, cohort_base)
);

CREATE TABLE pricing_plans (
  id               text PRIMARY KEY,
  plan             text NOT NULL CHECK (plan IN ('STET','TRE','BOTH')),
  level            text,
  paper            text,
  subject_id       text,
  duration_days    int  NOT NULL CHECK (duration_days > 0),
  base_price_paise int  NOT NULL CHECK (base_price_paise >= 0),
  discount_pct     numeric NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  tax_pct          numeric NOT NULL DEFAULT 18 CHECK (tax_pct BETWEEN 0 AND 100),
  active           boolean NOT NULL DEFAULT false,
  start_date       date,
  end_date         date
);

-- ---------------------------------------------------------------- payments & entitlements
CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  idempotency_key     text NOT NULL,
  razorpay_order_id   text UNIQUE,
  razorpay_payment_id text UNIQUE,
  amount_paise        int  NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','SUCCESS','FAILED','CANCELLED','EXPIRED','REFUNDED')),
  spec                jsonb NOT NULL,                     -- server-validated selection + prices (never trusted from client later)
  price_breakdown     jsonb NOT NULL,
  signature_verified  boolean NOT NULL DEFAULT false,
  verified_at         timestamptz,
  verified_via        text,                              -- CHECKOUT_VERIFY | WEBHOOK | RECONCILIATION
  failure_reason      text,
  refund_id           text,
  refunded_at         timestamptz,
  refunded_paise      int  NOT NULL DEFAULT 0,
  refund_requested_at timestamptz,                       -- guards against double refunds while Razorpay is called
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX payments_status_idx ON payments (status, created_at);

CREATE TABLE webhook_events (
  event_id     text PRIMARY KEY,                         -- X-Razorpay-Event-Id: duplicates are ignored
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL,
  processed_at timestamptz,
  result       text
);

CREATE TABLE purchases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  payment_id   uuid NOT NULL UNIQUE REFERENCES payments(id),
  plan         text NOT NULL,
  amount_paise int NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entitlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  purchase_id        uuid NOT NULL REFERENCES purchases(id),
  payment_id         uuid NOT NULL REFERENCES payments(id),
  plan_type          text NOT NULL,
  exam_type          text NOT NULL,
  level              text,
  paper              text,
  subject_id         text NOT NULL,                      -- subject id or 'other'
  subject_type       text NOT NULL CHECK (subject_type IN ('LISTED','OTHER')),
  other_subject_name text,
  other_subject_key  text,
  tre_language       text,
  question_lang      text NOT NULL DEFAULT 'en',
  explanation_lang   text NOT NULL DEFAULT 'hl',
  mode               text NOT NULL DEFAULT 'PRACTICE',
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','REFUNDED','CANCELLED')),
  cohort_base        text NOT NULL,
  purchased_at       timestamptz NOT NULL,
  activated_at       timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  duration_days      int NOT NULL,
  UNIQUE (payment_id, cohort_base)                       -- one payment can never create the same entitlement twice
);
CREATE INDEX entitlements_cohort_idx ON entitlements (cohort_base, status, expires_at);
CREATE INDEX entitlements_user_idx ON entitlements (user_id);

-- ---------------------------------------------------------------- questions, generation, mocks
CREATE TABLE questions (
  id               text PRIMARY KEY,
  origin_id        text NOT NULL,
  version          int  NOT NULL DEFAULT 1,
  status           text NOT NULL CHECK (status IN ('DRAFT','AI_GENERATED','REVIEW','REVIEWED','VALIDATING','VALIDATION_FAILED','VALIDATED','PUBLISHED','REJECTED','ARCHIVED')),
  exam_type        text,
  level            text,
  paper            text,
  section          text NOT NULL,
  subject_id       text NOT NULL,
  exam_lang        text,
  topic            text NOT NULL,
  subtopic         text NOT NULL,
  difficulty       text NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  question_type    text NOT NULL DEFAULT 'MCQ_SINGLE',
  correct_option   text NOT NULL,
  option_count     int  NOT NULL CHECK (option_count IN (4,5)),
  content          jsonb NOT NULL,                       -- {q:{hi,en,hl}, opts:{A:{..}}, why:{A:{..}}, exp, concept, tip}
  source_type      text NOT NULL CHECK (source_type IN ('ORIGINAL','PREVIOUS_YEAR','AI_GENERATED','ADMIN_CREATED','IMPORTED')),
  source_exam      text,
  source_year      int,
  source_document  text,
  source_url       text,
  current_affairs  jsonb,
  content_needed   boolean NOT NULL DEFAULT false,
  in_pool          boolean NOT NULL DEFAULT false,       -- reviewed bank question that generation may reuse
  fingerprint      text NOT NULL,
  semantic_hash    text NOT NULL,
  generated_for    text,
  job_id           uuid,
  review           jsonb,
  validation       jsonb,
  rejection        jsonb,
  revision_of      text,
  replaced_by      text,
  published_by     text,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (source_type <> 'PREVIOUS_YEAR' OR (source_exam IS NOT NULL AND source_year IS NOT NULL AND source_document IS NOT NULL)),
  CHECK (NOT (source_type = 'AI_GENERATED' AND (source_exam IS NOT NULL OR source_year IS NOT NULL)))
);
CREATE INDEX questions_pool_idx ON questions (subject_id, section, topic, subtopic) WHERE in_pool;
CREATE INDEX questions_origin_idx ON questions (origin_id);
CREATE INDEX questions_fp_idx ON questions (fingerprint);
CREATE INDEX questions_status_idx ON questions (status);

CREATE TABLE mocks (
  id                  text PRIMARY KEY,
  cohort_base         text NOT NULL,
  cohort_key          text NOT NULL,
  mock_no             int  NOT NULL,
  mock_date           date NOT NULL,
  exam_type           text NOT NULL,
  level               text,
  paper               text,
  subject_id          text NOT NULL,
  other_subject_key   text,
  other_subject_name  text,
  syllabus_subject_id text NOT NULL,
  tre_language        text,
  mode                text NOT NULL CHECK (mode IN ('PRACTICE','OFFICIAL')),
  config_id           text NOT NULL REFERENCES exam_configs(id),
  config_snapshot     jsonb NOT NULL,                    -- frozen sections/option keys/duration/marks used for scoring
  blueprint_id        text NOT NULL REFERENCES blueprints(id),
  question_ids        text[] NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','GENERATING','VALIDATING','REVIEW','APPROVED','PUBLISHED','CLOSED')),
  job_id              uuid,
  validation          jsonb,
  reuse               jsonb NOT NULL DEFAULT '[]',
  reuse_decision      text,
  approved_by         text,
  approved_at         timestamptz,
  published_by        text,
  published_at        timestamptz,
  assigned_count      int,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_base, mock_date)                        -- one shared mock per cohort per day
);
CREATE TABLE mock_questions (
  mock_id     text NOT NULL REFERENCES mocks(id),
  position    int  NOT NULL,
  question_id text NOT NULL,
  version     int  NOT NULL,
  frozen      jsonb NOT NULL,                            -- immutable copy used by every attempt
  PRIMARY KEY (mock_id, position)
);

CREATE TABLE generation_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,                  -- generate:{cohortKey}:{date}
  mock_id         text NOT NULL REFERENCES mocks(id),
  status          text NOT NULL CHECK (status IN ('QUEUED','RUNNING','COMPLETED','PARTIAL_FAILED','FAILED','CLAUDE_UNAVAILABLE','BUDGET_EXCEEDED')),
  batch_size      int  NOT NULL,
  total           int  NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  tokens_in       bigint NOT NULL DEFAULT 0,
  tokens_out      bigint NOT NULL DEFAULT 0
);
CREATE TABLE generation_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid NOT NULL REFERENCES generation_jobs(id),
  n            int  NOT NULL,
  section_id   text NOT NULL,
  slots        jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRYING','DONE','FAILED')),
  tries        int  NOT NULL DEFAULT 0,
  error        text,
  question_ids text[] NOT NULL DEFAULT '{}',
  tokens_in    bigint NOT NULL DEFAULT 0,
  tokens_out   bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, n)
);

-- ---------------------------------------------------------------- attempts
CREATE TABLE attempts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id),
  mock_id           text NOT NULL REFERENCES mocks(id),
  entitlement_id    uuid NOT NULL REFERENCES entitlements(id),
  status            text NOT NULL CHECK (status IN ('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED')),
  opened_at         timestamptz NOT NULL DEFAULT now(),
  server_started_at timestamptz NOT NULL,
  server_expires_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  submitted_at      timestamptz,
  submission_type   text CHECK (submission_type IN ('MANUAL','AUTO')),
  time_spent_sec    int,
  remaining_sec     int,
  result            jsonb,
  UNIQUE (user_id, mock_id)                              -- one student + one mock = one attempt
);
CREATE INDEX attempts_open_expiry_idx ON attempts (server_expires_at) WHERE status = 'IN_PROGRESS';

CREATE TABLE attempt_answers (
  attempt_id       uuid NOT NULL REFERENCES attempts(id),
  question_id      text NOT NULL,
  selected_option  text,
  marked           boolean NOT NULL DEFAULT false,
  time_spent_sec   int NOT NULL DEFAULT 0,
  answered_at      timestamptz,
  version          bigint NOT NULL,                      -- client hybrid clock (ms); older versions are ignored
  changes          int NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  type        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  mock_id     text,
  attempt_id  uuid,
  question_id text,
  data        jsonb
);
CREATE INDEX events_user_idx ON events (user_id, at DESC);

CREATE TABLE explanation_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  attempt_id   uuid NOT NULL REFERENCES attempts(id),
  mock_id      text NOT NULL,
  question_id  text NOT NULL,
  opened_at    timestamptz NOT NULL,
  closed_at    timestamptz,
  duration_sec int
);

-- ---------------------------------------------------------------- notifications, audit, ops
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience            text NOT NULL CHECK (audience IN ('student','admin')),
  user_id             uuid,
  type                text NOT NULL,
  title               text NOT NULL,
  message             text NOT NULL DEFAULT '',
  read                boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  related_mock_id     text,
  related_purchase_id uuid,
  cta                 jsonb
);
CREATE INDEX notifications_user_idx ON notifications (audience, user_id, created_at DESC);

CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,                              -- ADMIN | STUDENT | SYSTEM | WEBHOOK
  actor_id   text,
  actor_name text,
  role       text,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     text,
  after      text,
  reason     text,
  ip         text,
  request_id text
);
-- Audit records are append-only.
CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE deletion_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  status       text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','COMPLETED','REJECTED')),
  reason       text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processed_by text,
  note         text
);
CREATE UNIQUE INDEX deletion_requests_open_uq ON deletion_requests (user_id) WHERE status = 'REQUESTED';

CREATE TABLE support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES users(id),
  name       text NOT NULL,
  contact    text NOT NULL,
  category   text NOT NULL CHECK (category IN ('PAYMENT','ACCOUNT','MOCK','QUESTION','OTHER')),
  message    text NOT NULL CHECK (length(message) BETWEEN 5 AND 4000),
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('thresholds', '{"weak":50,"ni":70,"good":85,"minSample":3}'),
  ('refundPolicy', '"REVOKE"'),
  ('generation', '{"batchSize":5,"maxTries":3}'),
  ('availability', '{"minReadyMocks":7}');
