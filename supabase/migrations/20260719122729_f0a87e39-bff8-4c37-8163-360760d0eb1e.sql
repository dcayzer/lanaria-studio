-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.profiles to authenticated;
grant all on public.profiles to service_role;

alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Designs
create table public.designs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  chart_data jsonb,
  design_meta jsonb not null default '{}'::jsonb,
  thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.designs to authenticated;
grant all on public.designs to service_role;

alter table public.designs enable row level security;

create policy "Users can view their own designs"
  on public.designs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own designs"
  on public.designs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own designs"
  on public.designs for update
  using (auth.uid() = user_id);

create policy "Users can delete their own designs"
  on public.designs for delete
  using (auth.uid() = user_id);

create index designs_user_id_idx on public.designs(user_id);

create trigger designs_set_updated_at
  before update on public.designs
  for each row execute function public.set_updated_at();

-- Orders
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  design_id uuid not null references public.designs(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  order_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.orders to authenticated;
grant all on public.orders to service_role;

alter table public.orders enable row level security;

create policy "Users can view their own orders"
  on public.orders for select
  using (auth.uid() = user_id);

create policy "Users can insert their own orders"
  on public.orders for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own pending orders"
  on public.orders for update
  using (auth.uid() = user_id and status = 'pending');

create index orders_user_id_idx on public.orders(user_id);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();
