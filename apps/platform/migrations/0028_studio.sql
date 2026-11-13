-- Studio rooms (our StreamYard): a stage that goes live and into the recording, with people
-- backstage until the producer brings them on. The stage is kept between sessions.
alter table rooms
  add column studio boolean not null default false,
  add column studio_state jsonb not null default '{}'::jsonb
    check (jsonb_typeof(studio_state) = 'object' and pg_column_size(studio_state) <= 65536);

-- A studio recording is the stage as composed (layouts, banners, brand), not a grid of everyone.
alter table recordings add column studio boolean not null default false;
