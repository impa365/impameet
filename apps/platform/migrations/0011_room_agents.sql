-- A room may hold several AI agents at once (each with its own job); none means no AI.
-- Supersedes rooms.agent_enabled / rooms.agent_id (kept, no longer read).
create table room_agents (
  room_id uuid not null references rooms (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (room_id, agent_id)
);
create index room_agents_agent on room_agents (agent_id);

insert into room_agents (room_id, agent_id)
select r.id, coalesce(r.agent_id, d.id)
from rooms r
left join agents d on d.tenant_id = r.tenant_id and d.is_default
where r.agent_enabled and coalesce(r.agent_id, d.id) is not null;

-- What the agent is for, shown next to its name (optional).
alter table agents
  add column description text not null default '' check (char_length(description) <= 160);
