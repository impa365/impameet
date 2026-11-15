-- Live work product the agent builds during a call (plan, decisions, tasks, notes), and
-- allowing "workspace" among the agent's insights.
alter table agents drop constraint if exists agents_insights_check;
alter table agents add constraint agents_insights_check
  check (insights <@ array['minutes', 'catchup', 'copilot', 'metrics', 'workspace']::text[]);

alter table meeting_reports add column workspace jsonb;
