-- FFO Match: shared ratings table.
-- Run once in Supabase: SQL Editor → New query → paste this → Run.

create table if not exists public.ratings (
  id          bigint generated always as identity primary key,
  person      text not null check (char_length(person) between 1 and 40),
  restaurant  text not null check (char_length(restaurant) between 1 and 120),
  rating      smallint not null check (rating between 1 and 5),
  date        date not null default current_date,
  created_at  timestamptz not null default now(),
  -- One rating per person per place; rating again replaces the old one.
  unique (person, restaurant)
);

-- Row-level security: the public (anon) key may read ratings and add or change them,
-- but never delete. The checks above still apply to every write.
alter table public.ratings enable row level security;

drop policy if exists "anyone can read ratings" on public.ratings;
create policy "anyone can read ratings" on public.ratings
  for select to anon using (true);

drop policy if exists "anyone can add ratings" on public.ratings;
create policy "anyone can add ratings" on public.ratings
  for insert to anon with check (true);

drop policy if exists "anyone can update ratings" on public.ratings;
create policy "anyone can update ratings" on public.ratings
  for update to anon using (true) with check (true);

grant select, insert, update on public.ratings to anon;

-- Optional: copy the existing data/ratings.csv in with Table Editor → ratings → Insert → Import CSV
-- (columns person, restaurant, rating, date).
