-- migrate:up
-- Réplica analítica (PostgreSQL/RDS) de la tabla single-table de DynamoDB.
-- La escribe el projector (DynamoDB Streams) con UPSERTs idempotentes guardados por updated_at.
-- Nunca se guardan API keys, prompts ni código: solo IDs, conteos, hashes y procedencia.

CREATE TABLE IF NOT EXISTS projects (
  tenant_id         TEXT        NOT NULL,
  project_id        TEXT        NOT NULL,
  key_id            TEXT,
  repositories      TEXT[]      NOT NULL DEFAULT '{}',
  last_activity_at  TIMESTAMPTZ,
  provenance        TEXT        NOT NULL DEFAULT 'real',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  tenant_id          TEXT        NOT NULL,
  session_id         TEXT        NOT NULL,
  key_id             TEXT        NOT NULL,
  project_id         TEXT        NOT NULL,
  repository         TEXT        NOT NULL,
  branch             TEXT,
  task_key           TEXT,
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  end_reason         TEXT,
  last_activity_at   TIMESTAMPTZ,
  editor             TEXT,
  extension_version  TEXT,
  head_sha           TEXT,
  source             TEXT        NOT NULL,
  event_count        INTEGER     NOT NULL DEFAULT 0,
  provenance         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (tenant_id, project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_key_idx     ON sessions (tenant_id, key_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_task_idx    ON sessions (tenant_id, task_key) WHERE task_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_requests (
  tenant_id          TEXT        NOT NULL,
  session_id         TEXT        NOT NULL,
  ai_request_id      TEXT        NOT NULL,
  key_id             TEXT        NOT NULL,
  project_id         TEXT        NOT NULL,
  repository         TEXT        NOT NULL,
  branch             TEXT,
  task_key           TEXT,
  model              TEXT,
  status             TEXT        NOT NULL,
  latency_ms         INTEGER     NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  total_tokens       INTEGER,
  cached_tokens      INTEGER,
  usage_source       TEXT,
  output_hash        TEXT,
  regenerates        TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL,
  source             TEXT        NOT NULL,
  provenance         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, session_id, ai_request_id)
);
CREATE INDEX IF NOT EXISTS ai_requests_key_idx     ON ai_requests (tenant_id, key_id, occurred_at);
CREATE INDEX IF NOT EXISTS ai_requests_project_idx ON ai_requests (tenant_id, project_id, occurred_at);
CREATE INDEX IF NOT EXISTS ai_requests_output_idx  ON ai_requests (tenant_id, session_id, output_hash) WHERE output_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS changes (
  tenant_id               TEXT        NOT NULL,
  session_id              TEXT        NOT NULL,
  change_id               TEXT        NOT NULL,
  key_id                  TEXT        NOT NULL,
  project_id              TEXT        NOT NULL,
  repository              TEXT        NOT NULL,
  branch                  TEXT,
  task_key                TEXT,
  ai_request_id           TEXT,
  status                  TEXT        NOT NULL,
  first_seen_at           TIMESTAMPTZ NOT NULL,
  proposed_at             TIMESTAMPTZ,
  accepted_at             TIMESTAMPTZ,
  rejected_at             TIMESTAMPTZ,
  reject_reason           TEXT,
  committed_at            TIMESTAMPTZ,
  in_reference_at         TIMESTAMPTZ,
  deployed_at             TIMESTAMPTZ,
  proposed_added_lines    INTEGER,
  accepted_added_lines    INTEGER,
  accepted_deleted_lines  INTEGER,
  effective_lines         NUMERIC(12,4),
  importance_score        NUMERIC(6,4),
  redundancy_score        NUMERIC(6,4),
  mechanical_share        NUMERIC(6,4),
  files                   JSONB       NOT NULL DEFAULT '[]',
  dimensions              JSONB,
  scores                  JSONB,
  commit_sha              TEXT,
  reference_tags          TEXT[]      NOT NULL DEFAULT '{}',
  source                  TEXT,
  provenance              TEXT        NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, session_id, change_id)
);
CREATE INDEX IF NOT EXISTS changes_project_idx ON changes (tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS changes_request_idx ON changes (tenant_id, ai_request_id);
CREATE INDEX IF NOT EXISTS changes_commit_idx  ON changes (tenant_id, commit_sha) WHERE commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS changes_task_idx    ON changes (tenant_id, task_key) WHERE task_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS commits (
  tenant_id            TEXT        NOT NULL,
  repository           TEXT        NOT NULL,
  sha                  TEXT        NOT NULL,
  key_id               TEXT        NOT NULL,
  session_id           TEXT        NOT NULL,
  project_id           TEXT        NOT NULL,
  branch               TEXT,
  task_keys            TEXT[]      NOT NULL DEFAULT '{}',
  parent_sha           TEXT,
  committed_at         TIMESTAMPTZ NOT NULL,
  files                JSONB       NOT NULL DEFAULT '[]',
  change_ids           TEXT[]      NOT NULL DEFAULT '{}',
  automation           JSONB       NOT NULL,
  commit_added_lines   INTEGER,
  ai_matched_lines     INTEGER,
  ai_lost_lines        INTEGER,
  ai_share             NUMERIC(6,4),
  effective_lines      NUMERIC(12,4),
  has_session_trailer  BOOLEAN     NOT NULL DEFAULT false,
  remote_url           TEXT,
  commit_source        TEXT        NOT NULL,
  reference_tags       TEXT[]      NOT NULL DEFAULT '{}',
  source               TEXT,
  provenance           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, repository, sha)
);
CREATE INDEX IF NOT EXISTS commits_session_idx ON commits (tenant_id, session_id, committed_at);
CREATE INDEX IF NOT EXISTS commits_project_idx ON commits (tenant_id, project_id, committed_at);

-- `references` es palabra reservada en SQL → refs
CREATE TABLE IF NOT EXISTS refs (
  tenant_id                  TEXT        NOT NULL,
  repository                 TEXT        NOT NULL,
  tag                        TEXT        NOT NULL,
  key_id                     TEXT        NOT NULL,
  sha                        TEXT        NOT NULL,
  kind                       TEXT        NOT NULL CHECK (kind IN ('demo-reference', 'deployment')),
  evidence_url               TEXT,
  included_shas              TEXT[]      NOT NULL DEFAULT '{}',
  surviving_lines            INTEGER     NOT NULL DEFAULT 0,
  surviving_effective_lines  NUMERIC(12,4) NOT NULL DEFAULT 0,
  session_id                 TEXT,
  project_id                 TEXT,
  branch                     TEXT,
  marked_at                  TIMESTAMPTZ NOT NULL,
  source                     TEXT,
  provenance                 TEXT        NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, repository, tag)
);
CREATE INDEX IF NOT EXISTS refs_project_idx ON refs (tenant_id, project_id, marked_at);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  tenant_id          TEXT        NOT NULL,
  key_id             TEXT        NOT NULL,
  granularity        TEXT        NOT NULL CHECK (granularity IN ('request', 'hour', 'day')),
  window_key         TEXT        NOT NULL,
  window_start       TIMESTAMPTZ NOT NULL,
  window_end         TIMESTAMPTZ NOT NULL,
  request_id         TEXT,
  model              TEXT,
  prompt_tokens      INTEGER     NOT NULL DEFAULT 0,
  completion_tokens  INTEGER     NOT NULL DEFAULT 0,
  total_tokens       INTEGER     NOT NULL DEFAULT 0,
  cached_tokens      INTEGER,
  requests           INTEGER     NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(14,6),
  simulated          BOOLEAN     NOT NULL DEFAULT false,
  source             TEXT        NOT NULL,
  provenance         TEXT        NOT NULL,
  synced_at          TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, key_id, granularity, window_key)
);
CREATE INDEX IF NOT EXISTS usage_window_idx  ON usage_snapshots (tenant_id, key_id, window_start);
CREATE INDEX IF NOT EXISTS usage_request_idx ON usage_snapshots (tenant_id, request_id) WHERE request_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS usage_snapshots;
DROP TABLE IF EXISTS refs;
DROP TABLE IF EXISTS commits;
DROP TABLE IF EXISTS changes;
DROP TABLE IF EXISTS ai_requests;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS projects;
