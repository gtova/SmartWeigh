ALTER TABLE weigh_sessions ADD COLUMN hygiene_round int NOT NULL DEFAULT 1;
ALTER TABLE hygiene_steps ADD COLUMN round int NOT NULL DEFAULT 1;
