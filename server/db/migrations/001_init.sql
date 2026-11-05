-- PubAZ server schema v1 (Phase 1 beta). Postgres 15+ (Neon recommended).
-- Apply once, in order: psql "$DATABASE_URL" -f server/db/migrations/001_init.sql
-- Ids are text: user ids and attempt ids come from shared/ids.ts (26-char ULID-style).

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Account. Starts anonymous (one device); Phase 1 links Apple/Google/email identities.
CREATE TABLE users (
  id          text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Soft delete for "계정 삭제" requests; a nightly job hard-deletes after 30 days.
  deleted_at  timestamptz
);

-- A device (app install). device_id = Attempt.deviceId.
CREATE TABLE devices (
  device_id     text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Phase 1: SHA-256 of a device secret, bound on first auth (see docs/server-design.md).
  secret_hash   bytea,
  platform      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices (user_id);

-- Phase 1: external sign-in identities linked to a user (merge target for anonymous devices).
CREATE TABLE auth_identities (
  provider    text NOT NULL CHECK (provider IN ('apple', 'google', 'email')),
  subject     text NOT NULL,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

-- Append-only answer log. Never updated; sync is conflict-free because rows are immutable.
CREATE TABLE attempts (
  -- Server-side order for pull paging (cursor). Not the attempt id: ids carry client clocks.
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id           text NOT NULL,
  kind         text NOT NULL,
  at           timestamptz NOT NULL,
  grade        text NOT NULL CHECK (grade IN ('correct', 'mixed', 'wrong')),
  spot         text NOT NULL,
  device_id    text NOT NULL,
  -- The full validated Attempt as sent (unknown fields already stripped).
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempts_user_id_unique UNIQUE (user_id, id)
);
-- Pull paging: WHERE user_id = $1 AND seq > $2 ORDER BY seq.
CREATE INDEX attempts_pull_idx ON attempts (user_id, seq);
-- Per-user stats by quiz kind and date (KST day buckets are computed in queries).
CREATE INDEX attempts_stats_idx ON attempts (user_id, kind, at);
-- Review "same kind of question" and weak-spot selection for the daily quiz.
CREATE INDEX attempts_spot_idx ON attempts (user_id, spot, at DESC);

-- Usage counters, e.g. metric = 'coach', period = KST date '2026-11-05'.
CREATE TABLE usage_counters (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric   text NOT NULL,
  period   text NOT NULL,
  count    integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, metric, period)
);

-- Paid features. Written only by payment webhooks (Phase 2) or an admin script.
CREATE TABLE entitlements (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement  text NOT NULL CHECK (entitlement IN ('pro')),
  source       text NOT NULL CHECK (source IN ('revenuecat', 'toss', 'portone', 'manual')),
  external_id  text,
  expires_at   timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entitlement)
);

INSERT INTO schema_migrations (version) VALUES (1);

COMMIT;
