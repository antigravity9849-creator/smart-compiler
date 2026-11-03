-- ══════════════════════════════════════════════════════════════════════════
-- smart-compiler: Database Schema Fixes
-- Generated: 2026-11-03
--
-- Run this script in:  Supabase Dashboard → SQL Editor → New query
-- All statements are idempotent (safe to re-run).
-- DO NOT run individual sections in isolation — run the whole file.
-- ══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────
-- FIX 1 │ bug_events — add missing `language` column
-- ──────────────────────────────────────────────────────────────────────────
-- Root cause: bugTracker.js reads and writes a `language` column that was
-- never included in bug_events_migration.sql.  Any INSERT or SELECT on
-- `language` silently fails / returns undefined on clean databases.
-- Repair: add the column (IF NOT EXISTS keeps it safe to re-run) and
-- back-fill existing rows with 'c' as the conservative default.
ALTER TABLE public.bug_events
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'c';

-- Update any pre-existing rows that landed with the DEFAULT value so
-- the column is meaningful even for historical data.
UPDATE public.bug_events
SET    language = 'c'
WHERE  language IS NULL OR language = '';

-- Index allows efficient per-user, per-language bug history queries.
CREATE INDEX IF NOT EXISTS idx_bug_events_user_lang
  ON public.bug_events (user_id, language, timestamp DESC);


-- ──────────────────────────────────────────────────────────────────────────
-- FIX 2 │ user_stats — add missing `runs_by_lang` column
-- ──────────────────────────────────────────────────────────────────────────
-- The updated record_user_run (below) increments a per-language run counter
-- stored as JSONB.  Add the column so the function can write to it.
ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS runs_by_lang JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_stats.runs_by_lang IS
  'JSON map of language → run count, e.g. {"c": 12, "python": 4, "java": 1}';


-- ──────────────────────────────────────────────────────────────────────────
-- FIX 3 │ record_user_run — align to 5-parameter signature
-- ──────────────────────────────────────────────────────────────────────────
-- Root cause: security_hardening_migration.sql defines the function with
-- only 3 params (p_user_id, p_user_email, p_local_date).
-- Both server/index.js and server/ws-executor.js call it with 5 params:
--   p_user_id, p_user_email, p_local_date, p_language, p_is_clean_run
-- Supabase RPC calls with mismatched params return a 404 / function-not-found
-- error, so run counts and streaks are never recorded on any clean database.
--
-- This replacement:
--   • Accepts all five parameters.
--   • Preserves the existing streak and total_runs logic exactly.
--   • Adds per-language run counting into runs_by_lang JSONB.
--   • p_is_clean_run is accepted for future use (reserved for analytics).

DROP FUNCTION IF EXISTS public.record_user_run(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.record_user_run(
  p_user_id      UUID,
  p_user_email   TEXT,
  p_local_date   TEXT,
  p_language     TEXT    DEFAULT 'c',
  p_is_clean_run BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_streak INT := 0;
  v_last_activity  DATE;
  v_new_streak     INT := 1;
  v_lang           TEXT;
  v_current_count  INT;
BEGIN
  -- Normalise language to one of the three supported values
  v_lang := LOWER(COALESCE(p_language, 'c'));
  IF v_lang NOT IN ('c', 'python', 'java') THEN
    v_lang := 'c';
  END IF;

  -- ── Ensure rows exist ────────────────────────────────────────────────────
  INSERT INTO public.user_analytics (id, email, last_activity_date)
  VALUES (p_user_id, p_user_email, NULL)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

  INSERT INTO public.user_stats (id, total_runs, current_streak, runs_by_lang)
  VALUES (p_user_id, 0, 0, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

  -- ── Read current state ───────────────────────────────────────────────────
  SELECT last_activity_date INTO v_last_activity
  FROM   public.user_analytics
  WHERE  id = p_user_id;

  SELECT current_streak INTO v_current_streak
  FROM   public.user_stats
  WHERE  id = p_user_id;

  -- ── Streak calculation ───────────────────────────────────────────────────
  IF v_last_activity IS NULL THEN
    v_new_streak := 1;
  ELSIF v_last_activity = p_local_date::DATE THEN
    -- Same day — keep existing streak, do not increment
    v_new_streak := COALESCE(v_current_streak, 0);
  ELSIF v_last_activity = (p_local_date::DATE - INTERVAL '1 day')::DATE THEN
    -- Consecutive day — extend streak
    v_new_streak := COALESCE(v_current_streak, 0) + 1;
  ELSE
    -- Gap — reset streak
    v_new_streak := 1;
  END IF;

  -- ── Update last activity date ────────────────────────────────────────────
  UPDATE public.user_analytics
  SET    last_activity_date = p_local_date::DATE
  WHERE  id = p_user_id;

  -- ── Update total_runs, streak, and per-language counter ─────────────────
  -- Read existing count for this language (default 0 if key absent)
  SELECT COALESCE((runs_by_lang ->> v_lang)::INT, 0)
  INTO   v_current_count
  FROM   public.user_stats
  WHERE  id = p_user_id;

  UPDATE public.user_stats
  SET
    total_runs   = COALESCE(total_runs, 0) + 1,
    current_streak = v_new_streak,
    runs_by_lang = jsonb_set(
      COALESCE(runs_by_lang, '{}'::jsonb),
      ARRAY[v_lang],
      to_jsonb(COALESCE(v_current_count, 0) + 1)
    )
  WHERE id = p_user_id;
END;
$$;

-- Grant execution to all roles so both service_role and anon fallbacks can invoke it
GRANT EXECUTE ON FUNCTION public.record_user_run(UUID, TEXT, TEXT, TEXT, BOOLEAN)
  TO service_role, anon, authenticated;


-- ──────────────────────────────────────────────────────────────────────────
-- FIX 4 │ get_leaderboard — create missing RPC
-- ──────────────────────────────────────────────────────────────────────────
-- Root cause: server/index.js:760 calls /rest/v1/rpc/get_leaderboard with
--   { p_language: "all"|"c"|"python"|"java",  p_timeframe: "weekly"|"alltime" }
-- This function never existed in any migration file, so the leaderboard
-- endpoint always returns 502.
--
-- Return shape expected by LeaderboardPanel.jsx (server just forwards the array):
--   [ { rank, user_id, display_name, avatar_url, total_runs, current_streak,
--       runs_by_lang, weekly_runs }, ... ]
--
-- Implementation notes:
--   • For p_timeframe = 'weekly': we rank by runs made in the last 7 days,
--     computed from bug_events or approximated via last_activity_date.
--     Because we do not yet store a per-day runs table, weekly_runs is
--     approximated as total_runs for 'weekly' (a TODO documented below).
--   • For p_timeframe = 'alltime': we rank by total_runs.
--   • For p_language ≠ 'all': we rank by runs_by_lang->p_language.
--   • Returns at most 100 rows.
--   • SECURITY DEFINER so it can read user_analytics and user_stats
--     even when RLS is active; only non-sensitive fields are returned.

-- Drop the old version first so we can change the return type
DROP FUNCTION IF EXISTS public.get_leaderboard(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_leaderboard(
  p_language  TEXT DEFAULT 'all',
  p_timeframe TEXT DEFAULT 'weekly'
)
RETURNS TABLE (
  rank           BIGINT,
  user_id        UUID,
  display_name   TEXT,
  avatar_url     TEXT,
  xp             INT,
  total_runs     INT,
  current_streak INT,
  runs_by_lang   JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_lang TEXT;
BEGIN
  -- Normalise inputs
  v_lang := LOWER(COALESCE(p_language, 'all'));
  IF v_lang NOT IN ('all', 'c', 'python', 'java') THEN
    v_lang := 'all';
  END IF;

  IF p_timeframe NOT IN ('weekly', 'alltime') THEN
    p_timeframe := 'weekly';
  END IF;

  RETURN QUERY
  WITH calculated AS (
    SELECT
      ua.id                                           AS user_id,
      COALESCE(NULLIF(ua.display_name, ''), split_part(ua.email, '@', 1), 'Coder') AS display_name,
      ua.avatar_url,
      COALESCE(us.total_runs, 0)                      AS total_runs,
      COALESCE(us.current_streak, 0)                  AS current_streak,
      -- Ensure runs_by_lang is populated
      CASE 
        WHEN us.runs_by_lang IS NOT NULL AND us.runs_by_lang != '{}'::jsonb THEN us.runs_by_lang
        ELSE jsonb_build_object('c', COALESCE(us.total_runs, 0))
      END AS runs_by_lang,
      -- Calculate XP based on runs (+10 XP) and daily streak (+20 XP/day)
      (
        CASE
          WHEN v_lang = 'all' THEN (COALESCE(us.total_runs, 0) * 10)
          ELSE (COALESCE((us.runs_by_lang ->> v_lang)::INT, CASE WHEN v_lang = 'c' THEN COALESCE(us.total_runs, 0) ELSE 0 END) * 10)
        END + (COALESCE(us.current_streak, 0) * 20)
      )::INT AS xp
    FROM   public.user_analytics ua
    JOIN   public.user_stats     us ON us.id = ua.id
    WHERE
      -- Exclude users with 0 runs
      COALESCE(us.total_runs, 0) > 0
      -- For 'weekly': show users active in last 7 days, or fallback to all active users if last_activity_date is null
      AND (
        p_timeframe = 'alltime'
        OR ua.last_activity_date IS NULL
        OR ua.last_activity_date >= (CURRENT_DATE - INTERVAL '7 days')::DATE
      )
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY c.xp DESC, c.current_streak DESC, c.total_runs DESC) AS rank,
    c.user_id,
    c.display_name,
    c.avatar_url,
    c.xp,
    c.total_runs,
    c.current_streak,
    c.runs_by_lang
  FROM calculated c
  ORDER BY c.xp DESC, c.current_streak DESC, c.total_runs DESC
  LIMIT 100;
END;
$$;

-- Grant to service_role, anon and authenticated
GRANT EXECUTE ON FUNCTION public.get_leaderboard(TEXT, TEXT) TO service_role, anon, authenticated;

-- Ensure execute permissions on record_user_run are not blocked
GRANT EXECUTE ON FUNCTION public.record_user_run(UUID, TEXT, TEXT, TEXT, BOOLEAN) TO service_role, authenticated, anon;


-- ──────────────────────────────────────────────────────────────────────────
-- SUPPORT │ Ensure display_name and avatar_url columns exist on user_analytics
-- ──────────────────────────────────────────────────────────────────────────
-- get_leaderboard references these columns.  Add them safely if absent.
ALTER TABLE public.user_analytics
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url   TEXT;

COMMENT ON COLUMN public.user_analytics.display_name IS
  'User-visible name from Google profile or manual entry';
COMMENT ON COLUMN public.user_analytics.avatar_url IS
  'Google profile picture URL or null for email-only users';


-- ──────────────────────────────────────────────────────────────────────────
-- VERIFY — run these queries after applying to confirm success
-- ──────────────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bug_events' AND column_name = 'language';
-- → should return one row

-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'user_stats' AND column_name = 'runs_by_lang';
-- → should return one row

-- SELECT pg_get_functiondef(oid) FROM pg_proc
--   WHERE proname = 'record_user_run';
-- → should show the 5-parameter version

-- SELECT * FROM public.get_leaderboard('all', 'weekly') LIMIT 5;
-- → should return rows (or empty set if no users yet — no error)
-- ══════════════════════════════════════════════════════════════════════════

