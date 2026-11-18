-- Internship Hub schema (Neon Postgres + pgvector). Idempotent: safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  id           text PRIMARY KEY,
  company_key  text NOT NULL DEFAULT '',
  company      text NOT NULL DEFAULT '',
  title        text NOT NULL DEFAULT '',
  data         jsonb NOT NULL,              -- normalized job minus description/app/flags
  description  text NOT NULL DEFAULT '',
  app          jsonb NOT NULL DEFAULT '{"status":"none","notes":"","deadline":""}',
  active       boolean NOT NULL DEFAULT true,
  dream        boolean NOT NULL DEFAULT false,
  manual       boolean NOT NULL DEFAULT false,
  match        integer,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  emb_hash     text,
  title_vec    vector(512),
  body_vec     vector(512),
  fts          tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', title), 'A') ||
                 setweight(to_tsvector('english', company), 'B') ||
                 setweight(to_tsvector('english', left(description, 6000)), 'C')
               ) STORED
);
CREATE INDEX IF NOT EXISTS jobs_company_key_idx ON jobs (company_key);
CREATE INDEX IF NOT EXISTS jobs_fts_idx ON jobs USING gin (fts);
-- Dream-company roles wait for review before they join the hub:
-- '' = in the hub, 'pending' = found but not added yet, 'dismissed' = you passed on it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS review text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS companies (
  key        text PRIMARY KEY,
  name       text NOT NULL,
  ats        text NOT NULL,
  slug       text NOT NULL,
  site       text,
  region     text,
  dream      boolean NOT NULL DEFAULT false,
  position   serial,
  last_crawled_at timestamptz,
  last_error text
);

CREATE TABLE IF NOT EXISTS meta (
  key   text PRIMARY KEY,
  value jsonb
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,                -- crawl | dream
  label       text NOT NULL,
  status      text NOT NULL DEFAULT 'running',  -- running | done | failed
  queue       jsonb NOT NULL DEFAULT '[]',  -- company keys still to crawl
  total       integer NOT NULL DEFAULT 0,
  found       integer NOT NULL DEFAULT 0,
  log         jsonb NOT NULL DEFAULT '[]',
  result      jsonb,
  error       text,
  lease_until timestamptz,                  -- a step holds the run until this time
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS crawl_runs_started_idx ON crawl_runs (started_at DESC);
