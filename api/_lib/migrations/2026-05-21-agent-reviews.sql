-- Agent reviews table.
-- One review per (agent_id, user_id); POST upserts in place.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_reviews (
	id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
	agent_id   uuid        NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
	user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	rating     smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
	body       text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (agent_id, user_id)
);

CREATE INDEX IF NOT EXISTS agent_reviews_agent_id ON agent_reviews(agent_id);
CREATE INDEX IF NOT EXISTS agent_reviews_user_id  ON agent_reviews(user_id);

COMMIT;
