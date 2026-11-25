DROP TABLE IF EXISTS audit_log, session_events, notifications, recommendations, hygiene_steps,
  measurements, payments, weigh_sessions, otp_codes, consents, stations, users CASCADE;
DROP TYPE IF EXISTS session_state, consent_type, otp_channel, channel;
