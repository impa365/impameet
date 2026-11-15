-- Security: exclusive platform super-admins + per-tenant roles with editable permissions.
-- Platform powers never appear in org_role_permissions (separate catalog).

-- ── Platform super-admins (exclusive; not an org role) ───────────────────────
create table platform_superadmins (
  user_id     uuid primary key references users (id) on delete cascade,
  granted_by  uuid references users (id) on delete set null,
  granted_at  timestamptz not null default now()
);

create table platform_permission_defs (
  code         text primary key check (char_length(code) between 3 and 80),
  description  text not null check (char_length(description) between 1 and 200)
);

insert into platform_permission_defs (code, description) values
  ('platform.tenants.manage', 'Gerenciar organizações, planos e limites'),
  ('platform.mail.manage', 'Configurar e-mail da plataforma'),
  ('platform.google.manage', 'Configurar Google OAuth da plataforma'),
  ('platform.superadmins.manage', 'Conceder ou revogar super admin');

-- Keep users.is_superadmin in sync with the exclusive table (session reads the flag).
create or replace function sync_user_is_superadmin() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    update users set is_superadmin = false where id = old.user_id;
    return old;
  end if;
  update users set is_superadmin = true where id = new.user_id;
  return new;
end;
$$;

create trigger platform_superadmins_sync
  after insert or delete on platform_superadmins
  for each row execute function sync_user_is_superadmin();

-- Migrate anyone already flagged.
insert into platform_superadmins (user_id, granted_by)
select id, null from users where is_superadmin = true
on conflict (user_id) do nothing;

-- Bootstrap: if nobody is super admin yet, the earliest admin of the earliest tenant.
insert into platform_superadmins (user_id, granted_by)
select u.id, null
from users u
join tenants t on t.id = u.tenant_id
where u.role = 'admin' and u.status = 'active'
  and not exists (select 1 from platform_superadmins)
order by t.created_at, u.created_at
limit 1;

-- ── Tenant permission catalog (never overlaps platform_*) ────────────────────
create table org_permission_defs (
  code         text primary key check (char_length(code) between 3 and 80
                 and code not like 'platform.%'),
  category     text not null check (char_length(category) between 1 and 40),
  description  text not null check (char_length(description) between 1 and 200)
);

insert into org_permission_defs (code, category, description) values
  ('panel.access', 'panel', 'Abrir o painel de administração'),
  ('users.view', 'users', 'Ver a lista de usuários'),
  ('users.manage', 'users', 'Criar e editar usuários (conforme hierarquia)'),
  ('users.assign_admin', 'users', 'Atribuir o papel de administrador'),
  ('roles.manage', 'roles', 'Editar papéis e permissões da organização'),
  ('rooms.manage_all', 'rooms', 'Gerenciar todas as salas como organizador'),
  ('agents.manage', 'agents', 'Gerenciar agentes de IA'),
  ('knowledge.manage', 'knowledge', 'Gerenciar base de conhecimento'),
  ('integrations.manage', 'integrations', 'Gerenciar integrações'),
  ('branding.manage', 'branding', 'Editar marca e aparência'),
  ('domains.manage', 'domains', 'Gerenciar domínios'),
  ('email.manage', 'email', 'Configurar e-mail da organização'),
  ('storage.manage', 'storage', 'Configurar armazenamento'),
  ('live.manage', 'live', 'Ver e gerenciar salas ao vivo'),
  ('streaming.manage', 'streaming', 'Configurar streaming'),
  ('security.manage', 'security', 'Configurar segurança (MFA, políticas)'),
  ('audit.view', 'audit', 'Ver o registro de auditoria');

create table org_roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  key         text not null check (key ~ '^[a-z][a-z0-9_]{0,31}$' and key not in ('guest', 'moderator', 'participant')),
  name        text not null check (char_length(name) between 1 and 60),
  description text not null default '' check (char_length(description) <= 200),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);

create table org_role_permissions (
  role_id          uuid not null references org_roles (id) on delete cascade,
  permission_code  text not null references org_permission_defs (code) on delete cascade,
  primary key (role_id, permission_code)
);

create index org_roles_tenant_idx on org_roles (tenant_id);

-- Seed built-in roles for every existing tenant.
insert into org_roles (tenant_id, key, name, description, is_system)
select t.id, r.key, r.name, r.description, true
from tenants t
cross join (values
  ('admin', 'Administrador', 'Acesso completo à organização'),
  ('manager', 'Gestor', 'Usuários e salas ao vivo'),
  ('member', 'Usuário', 'Participante sem painel administrativo')
) as r(key, name, description);

-- Admin: all org permissions.
insert into org_role_permissions (role_id, permission_code)
select r.id, p.code
from org_roles r
cross join org_permission_defs p
where r.key = 'admin' and r.is_system;

-- Manager: users + live + manage all rooms (matches previous hard-coded staff).
insert into org_role_permissions (role_id, permission_code)
select r.id, p.code
from org_roles r
cross join (values
  ('panel.access'),
  ('users.view'),
  ('users.manage'),
  ('rooms.manage_all'),
  ('live.manage')
) as p(code)
where r.key = 'manager' and r.is_system;

-- Member: no admin permissions (empty).

-- Free users.role from the fixed enum so custom role keys can be assigned.
alter table users drop constraint if exists users_role_check;
alter table users
  add constraint users_role_org_fkey
  foreign key (tenant_id, role) references org_roles (tenant_id, key);
