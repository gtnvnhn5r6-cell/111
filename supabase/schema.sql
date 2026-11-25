-- DeepSeek Chatbox — Supabase schema
-- Run this once in Supabase Dashboard → SQL Editor.
-- The anon key cannot create tables, so this step needs the project owner.

create table if not exists public.chat_conversations (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default '未命名对话',
  data jsonb not null,
  client_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_conversations_data_object
    check (jsonb_typeof(data) = 'object')
);

create index if not exists chat_conversations_user_updated_idx
  on public.chat_conversations (user_id, updated_at desc);

alter table public.chat_conversations enable row level security;

drop policy if exists "chat_conversations_select_own" on public.chat_conversations;
create policy "chat_conversations_select_own"
  on public.chat_conversations
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "chat_conversations_insert_own" on public.chat_conversations;
create policy "chat_conversations_insert_own"
  on public.chat_conversations
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_conversations_update_own" on public.chat_conversations;
create policy "chat_conversations_update_own"
  on public.chat_conversations
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "chat_conversations_delete_own" on public.chat_conversations;
create policy "chat_conversations_delete_own"
  on public.chat_conversations
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.chat_conversations from anon;
grant select, insert, update, delete on table public.chat_conversations to authenticated;

create or replace function public.touch_chat_conversations_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists chat_conversations_touch_updated_at
  on public.chat_conversations;

create trigger chat_conversations_touch_updated_at
  before update on public.chat_conversations
  for each row
  execute function public.touch_chat_conversations_updated_at();
