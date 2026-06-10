-- release201/08 §5.2 — Eval session run history.
--
-- Each row records one eval session (queued → running → finished|aborted|error).
-- Daemon-side eval-session runner posts results back via
-- POST /api/im/skills/:id/eval/runs/:runId/finish, which writes results_json,
-- and either auto-promotes eval→review (pass rate ≥ threshold) or leaves the
-- skill at lifecycle_stage='eval' for owner to retry / rollback.
--
-- No FK to im_skills — the service layer validates skill_id existence; this
-- keeps eval history retained even if the parent skill is later archived.

CREATE TABLE IF NOT EXISTS im_skill_eval_runs (
  id              VARCHAR(30)  NOT NULL,
  skill_id        VARCHAR(30)  NOT NULL,
  status          VARCHAR(20)  NOT NULL,            -- queued|running|finished|aborted|error
  daemon_id       VARCHAR(30)  NULL,
  pass_count      INT          NOT NULL DEFAULT 0,
  fail_count      INT          NOT NULL DEFAULT 0,
  test_cases_json TEXT         NOT NULL,
  results_json    TEXT         NULL,
  agent_trace_url VARCHAR(500) NULL,
  started_at      DATETIME(3)  NULL,
  finished_at     DATETIME(3)  NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX idx_skill (skill_id),
  INDEX idx_status (status),
  INDEX idx_created (created_at)
);
