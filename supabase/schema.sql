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
