-- Web Comic Reader: per-user sync of reading progress and settings.
-- Run in the Supabase SQL editor (Project > SQL Editor > New query).
-- The file is idempotent: running it again in full is safe.
-- The block at the end was added later; projects set up before it must run
-- that block (or the whole file) once.
-- Every row belongs to one user; row level security lets each signed-in user
-- read and write only their own rows. Anonymous visitors get no data.

-- Reading progress, one row per comic file name -----------------------------
create table if not exists public.reading_progress (
    user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
    file_name   text        not null check (char_length(file_name) between 1 and 512),
    last_page   integer     not null default 0 check (last_page >= 0),
    total_pages integer              check (total_pages is null or total_pages > 0),
    source      text                 check (source is null or source in ('upload', 'folder', 'telegram')),
    hidden      boolean     not null default false,  -- removed from "Recently Read", progress kept
    read_at     timestamptz not null default now(),  -- last time the comic was read
    updated_at  timestamptz not null default now(),  -- last change of this row (sync merge)
    primary key (user_id, file_name)
);

create index if not exists reading_progress_user_updated on public.reading_progress (user_id, updated_at desc);

-- Settings: reader preferences and the "My channels" list, one row per user -
create or replace function public.valid_channel_list(names text[])
returns boolean
language sql
immutable
as $$
    select coalesce(cardinality(names), 0) <= 50
       and coalesce(bool_and(n ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$'), true)
    from unnest(names) as n
$$;

create table if not exists public.user_settings (
    user_id    uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
    reader     jsonb       not null default '{}'::jsonb check (pg_column_size(reader) < 4096),
    channels   text[]      not null default '{}' check (public.valid_channel_list(channels)),
    updated_at timestamptz not null default now()
);

-- Row level security ----------------------------------------------------------
alter table public.reading_progress enable row level security;
alter table public.user_settings    enable row level security;

drop policy if exists "own progress" on public.reading_progress;
create policy "own progress" on public.reading_progress
    for all to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
    for all to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

revoke all on public.reading_progress, public.user_settings from anon;
grant select, insert, update, delete on public.reading_progress, public.user_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Added 2026-10: keep-alive ping and safer automatic sync. Safe to run again.
-- Run this block (or the whole file) once in the Supabase SQL editor.
-- The site keeps working before it has been run.
-- Owner: plan item 1 (keepalive-ci) appends this block; item 2 (auto-sync)
-- uses server_updated_at and the trigger.
-- ---------------------------------------------------------------------------

-- Keep-alive for .github/workflows/supabase-keepalive.yml: free projects are
-- paused after a week without database activity. The workflow calls this as
-- anon once a day; it reads no table and returns only the database time.
create or replace function public.keepalive()
returns timestamptz
language sql
stable
security invoker
set search_path = ''
as $$
    select now()
$$;

revoke all on function public.keepalive() from public;
grant execute on function public.keepalive() to anon, authenticated;

-- Automatic sync: server_updated_at is the database time of a row's last
-- change. The app pulls only rows changed since its last pull, so device
-- clocks no longer decide what is fetched.
alter table public.reading_progress add column if not exists server_updated_at timestamptz not null default now();
alter table public.user_settings    add column if not exists server_updated_at timestamptz not null default now();
create index if not exists reading_progress_user_server_updated on public.reading_progress (user_id, server_updated_at);

-- Stamps server_updated_at, caps device clocks that run ahead, and keeps the
-- newer row when a device with older data pushes: that row is skipped, the
-- rest of the batch is still saved.
create or replace function public.sync_stamp_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := least(new.updated_at, now() + interval '2 minutes');
    if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
        return null;
    end if;
    new.server_updated_at := now();
    return new;
end;
$$;

drop trigger if exists sync_stamp_row on public.reading_progress;
drop trigger if exists sync_stamp_row on public.user_settings;

-- one-off: rows stored earlier by a device whose clock ran ahead
-- (runs while the triggers are dropped, so it is not skipped by them)
update public.reading_progress set updated_at = now() where updated_at > now() + interval '2 minutes';
update public.user_settings    set updated_at = now() where updated_at > now() + interval '2 minutes';

create trigger sync_stamp_row before insert or update on public.reading_progress
    for each row execute function public.sync_stamp_row();
create trigger sync_stamp_row before insert or update on public.user_settings
    for each row execute function public.sync_stamp_row();

-- let the Data API see the new function and columns right away
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Added 2026-10: "Delete my account" and the owner-only admin panel. Safe to
-- run again. Run this block (or the whole file) once in the SQL editor; the
-- site keeps working before that (no Admin button, account deletion reports
-- that the server is not set up yet).
-- Every function that does more than the caller's own row level security
-- allows is security definer, checks the caller first, and is callable only
-- by signed-in users. The browser only ever holds the publishable key and the
-- user's own session.
--
-- Make yourself an admin afterwards (your address, run once):
--   insert into public.app_admins (user_id) select id from auth.users where email = 'you@example.com' on conflict do nothing;
-- The sign-up switch takes effect only once Authentication > Hooks >
-- Before User Created points to public.hook_before_user_created.
-- ---------------------------------------------------------------------------

-- Delete my account: the caller's auth user goes, and with it (on delete
-- cascade) their reading_progress and user_settings rows, identities and
-- sessions.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    uid uuid := auth.uid();
begin
    if uid is null then
        raise exception 'not signed in' using errcode = '42501';
    end if;
    delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Admins: no policies, no grants for the API roles; only the security
-- definer functions below read it.
create table if not exists public.app_admins (
    user_id  uuid        primary key references auth.users (id) on delete cascade,
    added_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on public.app_admins from anon, authenticated;

-- One row of site settings
create table if not exists public.app_config (
    id           boolean     primary key default true check (id),
    signups_open boolean     not null default true,
    updated_at   timestamptz not null default now()
);
insert into public.app_config (id) values (true) on conflict do nothing;
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()))
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Admin RPCs: each refuses a caller that is not in app_admins (42501, the
-- Data API answers 403).
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    return json_build_object(
        'users_total',     (select count(*) from auth.users),
        'users_confirmed', (select count(*) from auth.users u where u.email_confirmed_at is not null),
        'signed_in_7d',    (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '7 days'),
        'signed_in_30d',   (select count(*) from auth.users u where u.last_sign_in_at > now() - interval '30 days'),
        'users_banned',    (select count(*) from auth.users u where u.banned_until > now()),
        'progress_rows',   (select count(*) from public.reading_progress),
        'active_7d',       (select count(*) from (
                                select p.user_id from public.reading_progress p where p.server_updated_at > now() - interval '7 days'
                                union
                                select s.user_id from public.user_settings s where s.server_updated_at > now() - interval '7 days'
                            ) active),
        'settings_rows',   (select count(*) from public.user_settings),
        'signups_open',    coalesce((select c.signups_open from public.app_config c where c.id), true),
        'db_size_bytes',   pg_database_size(current_database()),
        'generated_at',    now()
    );
end;
$$;

-- last_activity: the newest synced change (server clock) of progress or settings
create or replace function public.admin_list_users()
returns table (
    id                 uuid,
    email              text,
    created_at         timestamptz,
    last_sign_in_at    timestamptz,
    email_confirmed_at timestamptz,
    banned_until       timestamptz,
    is_admin           boolean,
    comics             bigint,
    last_activity      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    return query
    select u.id,
           u.email::text,
           u.created_at,
           u.last_sign_in_at,
           u.email_confirmed_at,
           u.banned_until,
           a.user_id is not null,
           coalesce(p.comics, 0)::bigint,
           greatest(p.last_change, s.server_updated_at)
    from auth.users u
    left join public.app_admins a on a.user_id = u.id
    left join (
        select rp.user_id, count(*) as comics, max(rp.server_updated_at) as last_change
        from public.reading_progress rp
        group by rp.user_id
    ) p on p.user_id = u.id
    left join public.user_settings s on s.user_id = u.id
    order by greatest(p.last_change, s.server_updated_at) desc nulls last,
             u.last_sign_in_at desc nulls last,
             u.created_at desc;
end;
$$;

-- A ban lasts 100 years, like the Auth admin API's ban_duration. Not
-- 'infinity': Supabase Auth reads banned_until into a Go time value, which
-- cannot hold it, and would fail to load that user. Auth refuses sign-ins and
-- token refreshes of a banned user; an access token already issued keeps
-- working for the Data API until it expires (1 hour by default).
create or replace function public.admin_set_banned(target uuid, banned boolean)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
    ban_end timestamptz;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    if admin_set_banned.target is null or admin_set_banned.banned is null then
        raise exception 'target and banned are required' using errcode = '22004';
    end if;
    if admin_set_banned.target = auth.uid() then
        raise exception 'you cannot ban your own account' using errcode = '22023';
    end if;
    update auth.users u
       set banned_until = case when admin_set_banned.banned then now() + interval '100 years' end
     where u.id = admin_set_banned.target
    returning u.banned_until into ban_end;
    if not found then
        raise exception 'user not found' using errcode = 'P0002';
    end if;
    return ban_end;
end;
$$;

create or replace function public.admin_delete_user_data(target uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
    progress_count bigint;
    settings_count bigint;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    if admin_delete_user_data.target is null then
        raise exception 'target is required' using errcode = '22004';
    end if;
    -- your own data: "Delete my synced data" in the account view also resets this device's sync state
    if admin_delete_user_data.target = auth.uid() then
        raise exception 'use Delete my synced data for your own account' using errcode = '22023';
    end if;
    delete from public.reading_progress p where p.user_id = admin_delete_user_data.target;
    get diagnostics progress_count = row_count;
    delete from public.user_settings s where s.user_id = admin_delete_user_data.target;
    get diagnostics settings_count = row_count;
    return json_build_object('progress_rows', progress_count, 'settings_rows', settings_count);
end;
$$;

create or replace function public.admin_delete_user(target uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    if admin_delete_user.target is null then
        raise exception 'target is required' using errcode = '22004';
    end if;
    if admin_delete_user.target = auth.uid() then
        raise exception 'you cannot delete your own account here' using errcode = '22023';
    end if;
    delete from auth.users u where u.id = admin_delete_user.target;
    if not found then
        raise exception 'user not found' using errcode = 'P0002';
    end if;
    return true;
end;
$$;

create or replace function public.admin_set_signups(open boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = '42501';
    end if;
    if admin_set_signups.open is null then
        raise exception 'open is required' using errcode = '22004';
    end if;
    insert into public.app_config (id, signups_open, updated_at)
    values (true, admin_set_signups.open, now())
    on conflict (id) do update set signups_open = excluded.signups_open, updated_at = excluded.updated_at;
    return admin_set_signups.open;
end;
$$;

revoke all on function public.admin_overview() from public, anon;
revoke all on function public.admin_list_users() from public, anon;
revoke all on function public.admin_set_banned(uuid, boolean) from public, anon;
revoke all on function public.admin_delete_user_data(uuid) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
revoke all on function public.admin_set_signups(boolean) from public, anon;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_set_banned(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_user_data(uuid) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
grant execute on function public.admin_set_signups(boolean) to authenticated;

-- "Before User Created" auth hook (Free plan and up): refuses new accounts
-- while app_config.signups_open is false. Enable it in Authentication > Hooks
-- (Postgres function, schema public, hook_before_user_created). Supabase Auth
-- calls it as supabase_auth_admin: {} lets the sign-up go on, an error object
-- stops it with that HTTP status. It also stops invites and first OAuth
-- sign-ins; users added in Authentication > Users > Add user are not checked.
-- Security invoker, as the Supabase docs advise: supabase_auth_admin gets
-- read access to app_config alone.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
    if coalesce((select c.signups_open from public.app_config c where c.id), true) then
        return '{}'::jsonb;
    end if;
    return jsonb_build_object('error', jsonb_build_object(
        'http_code', 403,
        'message', 'New sign-ups are closed.'
    ));
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant select on public.app_config to supabase_auth_admin;
drop policy if exists "auth reads signup switch" on public.app_config;
create policy "auth reads signup switch" on public.app_config
    for select to supabase_auth_admin
    using (true);
revoke all on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

notify pgrst, 'reload schema';
