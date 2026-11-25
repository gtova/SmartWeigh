DELETE FROM payments WHERE session_id IS NULL;
ALTER TABLE payments DROP CONSTRAINT payments_session_id_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_session_id_fkey FOREIGN KEY (session_id) REFERENCES weigh_sessions(id) ON DELETE CASCADE;
ALTER TABLE payments ALTER COLUMN session_id SET NOT NULL;
