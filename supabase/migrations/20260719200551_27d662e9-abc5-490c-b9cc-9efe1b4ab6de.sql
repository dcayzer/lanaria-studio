create table public.motifs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  width int not null check (width > 0),
  height int not null check (height > 0),
  cells jsonb not null,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.motifs to anon;
grant select, insert, update, delete on public.motifs to authenticated;
grant all on public.motifs to service_role;

alter table public.motifs enable row level security;

create policy "Anyone can view preloaded or own motifs"
  on public.motifs for select
  using (user_id is null or auth.uid() = user_id);

create policy "Users can insert their own motifs"
  on public.motifs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own motifs"
  on public.motifs for update
  using (auth.uid() = user_id);

create policy "Users can delete their own motifs"
  on public.motifs for delete
  using (auth.uid() = user_id);

create index motifs_user_id_idx on public.motifs(user_id);

create trigger motifs_set_updated_at
  before update on public.motifs
  for each row execute function public.set_updated_at();
