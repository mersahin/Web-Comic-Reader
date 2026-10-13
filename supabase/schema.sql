-- Web Comic Reader: per-user sync of reading progress and settings.
-- Run once in the Supabase SQL editor (Project > SQL Editor > New query).
-- Every row belongs to one user; row level security lets each signed-in user
-- read and write only their own rows. Anonymous visitors get nothing.

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
