-- Talent Auction · worldwide leaderboard
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste everything → Run.
-- Safe to run again (it only creates what is missing and refreshes the views).

create table if not exists public.scores (
  id           bigserial primary key,
  created_at   timestamptz not null default now(),
  nickname     text        not null check (char_length(nickname) between 2 and 16),
  nick_key     text        generated always as (lower(nickname)) stored,
  problem      text        not null check (problem ~ '^C[1-9]$'),
  company      text,
  score        numeric(6,2) not null check (score between -200 and 200),
  ai_score     numeric(6,2) not null,
  won          boolean     not null,
  captain      text,
  seed         text        not null,
  moves        integer,
  app_version  text,
  data_version text
);

-- one entry per game per nickname (the same game can't be sent twice)
create unique index if not exists scores_one_per_game on public.scores (seed, problem, nick_key);
create index if not exists scores_problem_score on public.scores (problem, score desc);

-- Row Level Security: anyone may READ; nobody may write from the browser.
-- Scores are written only by the submit-score Edge Function, after it has replayed the game.
alter table public.scores enable row level security;
drop policy if exists "Leaderboard is public" on public.scores;
create policy "Leaderboard is public" on public.scores for select using (true);
revoke insert, update, delete on public.scores from anon, authenticated;
grant select on public.scores to anon, authenticated;

-- Best score per nickname per problem (the per-problem top 10 reads this)
create or replace view public.best_scores with (security_invoker = true) as
select distinct on (problem, nick_key)
       nickname, nick_key, problem, company, score, ai_score, won, captain, created_at
  from public.scores
 order by problem, nick_key, score desc, created_at asc;

-- Overall: the average of each player's best scores, once they have played at least 3 different problems
create or replace view public.overall_scores with (security_invoker = true) as
select (array_agg(nickname order by created_at desc))[1] as nickname,
       nick_key,
       count(*)::int                       as problems,
       round(avg(score), 2)                as avg_score,
       count(*) filter (where won)::int    as wins,
       max(created_at)                     as last_played
  from public.best_scores
 group by nick_key
having count(*) >= 3;

grant select on public.best_scores, public.overall_scores to anon, authenticated;

-- Handy admin queries (run by hand when needed):
--   delete from public.scores where nick_key = 'some name';   -- remove one player
--   delete from public.scores;                                  -- reset the whole board
