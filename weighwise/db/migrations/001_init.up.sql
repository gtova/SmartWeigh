CREATE TYPE channel AS ENUM ('email','sms');
CREATE TYPE otp_channel AS ENUM ('email','sms','voice');
CREATE TYPE consent_type AS ENUM ('terms','sms','ai_processing','device_suitability');
CREATE TYPE session_state AS ENUM (
  'created','paid','hygiene_in_progress','prep_confirmed','measuring','measured','saved','notified',
  'failed_payment','abandoned','failed_measure','failed_notify');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  phone text UNIQUE,
  full_name text,
  birth_year int,
  height_cm int,
  preferred_channel channel NOT NULL DEFAULT 'email',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_contact_chk CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  device_key_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_seen_at timestamptz
);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type consent_type NOT NULL,
  terms_version text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX consents_user_idx ON consents(user_id);

CREATE TABLE otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  channel otp_channel NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_target_idx ON otp_codes(target);

CREATE TABLE weigh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id uuid NOT NULL REFERENCES stations(id),
  state session_state NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  hygiene_done_at timestamptz,
  prep_confirmed_at timestamptz,
  measured_at timestamptz,
  saved_at timestamptz,
  notified_at timestamptz,
  measure_attempts int NOT NULL DEFAULT 0,
  needs_review boolean NOT NULL DEFAULT false,
  device_suitability_confirmed_at timestamptz
);
CREATE INDEX weigh_sessions_state_idx ON weigh_sessions(state);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES weigh_sessions(id) ON DELETE CASCADE,
  status text NOT NULL,
  provider text NOT NULL,
  provider_txn_id text,
  amount int NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE REFERENCES weigh_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight_kg numeric(5,1) NOT NULL,
  bmi numeric(4,1),
  body_fat_pct numeric(4,1),
  muscle_mass_kg numeric(5,1),
  body_water_pct numeric(4,1),
  raw_payload jsonb,
  measured_at timestamptz NOT NULL DEFAULT now(),
  station_id uuid NOT NULL,
  is_outlier boolean NOT NULL DEFAULT false,
  is_stable boolean NOT NULL DEFAULT true
);
CREATE INDEX measurements_user_time_idx ON measurements(user_id, measured_at);

CREATE TABLE hygiene_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES weigh_sessions(id) ON DELETE CASCADE,
  step_no int NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hygiene_steps_session_idx ON hygiene_steps(session_id);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_id uuid NOT NULL UNIQUE REFERENCES measurements(id) ON DELETE CASCADE,
  explanation text NOT NULL,
  recommendations jsonb NOT NULL,
  suggest_professional boolean NOT NULL DEFAULT false,
  prompt_version text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_id uuid NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  channel channel NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz
);

CREATE TABLE session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES weigh_sessions(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  meta jsonb
);
CREATE INDEX session_events_session_idx ON session_events(session_id);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text,
  actor_role text NOT NULL,
  action text NOT NULL,
  target text,
  at timestamptz NOT NULL DEFAULT now()
);
