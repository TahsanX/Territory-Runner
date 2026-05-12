-- ============================================================================
-- Territory Runner — Supabase / PostGIS schema
-- ============================================================================
-- Idempotent: safe to re-run. Run against the DIRECT connection string
-- (port 5432), not the pooler, via `npm run init-db`.
--
-- Identity lives in Supabase's auth.users (UUID). public.profiles holds app
-- data only; passwords and linked OAuth providers are Supabase's concern.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------------------
-- profiles — app-level user data, 1:1 with auth.users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    VARCHAR(255) UNIQUE NOT NULL,
  avatar_url  TEXT,
  -- Replaces the 70 kg hardcoded in geoUtils.calculateRunningStats
  weight_kg   NUMERIC(5,2) NOT NULL DEFAULT 70 CHECK (weight_kg > 20 AND weight_kg < 400),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- running_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS running_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_time         TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time           TIMESTAMPTZ,
  is_closed_loop     BOOLEAN NOT NULL DEFAULT FALSE,
  total_distance     DOUBLE PRECISION NOT NULL DEFAULT 0,   -- km
  total_time         INTEGER NOT NULL DEFAULT 0,            -- seconds, moving time
  estimated_calories INTEGER NOT NULL DEFAULT 0,
  -- Reverse-geocoded ONCE on finish and cached forever, so the "places visited
  -- most" summary is a GROUP BY on a stored string, not an API call per view.
  place_name         TEXT,
  place_locality     TEXT,
  -- The runner's LOCAL day. Streaks computed in UTC break for anyone running
  -- late at night outside UTC (e.g. a 1am run in UTC+6 is the previous UTC day).
  local_date         DATE,
  tz_offset_minutes  INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- route_coordinates
-- `seq` is a client-generated monotonic counter. The UNIQUE constraint makes
-- batch uploads idempotent: a replayed batch (mobile reconnect, sendBeacon
-- double-fire) is absorbed by ON CONFLICT DO NOTHING instead of duplicating
-- the track and inflating distance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_coordinates (
  id                 BIGSERIAL PRIMARY KEY,
  running_session_id BIGINT NOT NULL REFERENCES running_sessions(id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  latitude           DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90  AND 90),
  longitude          DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m         DOUBLE PRECISION,
  -- Replaces the [999, 999] sentinel coordinate that used to be written into
  -- the track to mark a pause. Latitude 999 failed the CHECK above anyway.
  is_pause_marker    BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_coordinates_session_seq_key UNIQUE (running_session_id, seq)
);

-- ---------------------------------------------------------------------------
-- territories
-- geom is MultiPolygon, not Polygon: ST_Difference can split a territory in
-- two (a run straight through the middle) or punch a hole in it (a run wholly
-- inside it). The old code stored a single ring and silently discarded the
-- rest. area_m2 is stored, never computed per query, so the leaderboard and
-- map never call ST_Area.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS territories (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  running_session_id BIGINT REFERENCES running_sessions(id) ON DELETE SET NULL,
  geom               geometry(MultiPolygon, 4326) NOT NULL,
  area_m2            DOUBLE PRECISION NOT NULL,
  -- Label anchor. ST_PointOnSurface, NOT the centroid: a centroid can land
  -- outside a concave territory or inside the hole of a donut — exactly the
  -- shapes that stealing produces.
  label_lat          DOUBLE PRECISION,
  label_lon          DOUBLE PRECISION,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT territories_geom_valid CHECK (ST_IsValid(geom))
);

-- ---------------------------------------------------------------------------
-- territory_events — the steal audit log.
-- Replaces the territory_conflicts table that was declared but never written.
-- Feeds "area lost" in the summaries and the Phase 2 "your territory was
-- taken" push notification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS territory_events (
  id                  BIGSERIAL PRIMARY KEY,
  attacker_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  defender_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  attacker_territory_id BIGINT REFERENCES territories(id) ON DELETE SET NULL,
  defender_territory_id BIGINT,
  area_transferred_m2 DOUBLE PRECISION NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('trimmed', 'consumed', 'merged')),
  local_date          DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- user_statistics — denormalised lifetime totals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_statistics (
  user_id                UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  total_distance         DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_time             INTEGER NOT NULL DEFAULT 0,
  total_calories         INTEGER NOT NULL DEFAULT 0,
  total_territory_area   DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_running_sessions INTEGER NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- user_daily_activity — one row per user per LOCAL day.
-- Single source for the streak calendar AND both summaries. Written once per
-- finished run so the calendar is one indexed range scan rather than an
-- aggregate over raw sessions on every page load.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_daily_activity (
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  local_date     DATE NOT NULL,
  runs           INTEGER NOT NULL DEFAULT 0,
  distance_km    DOUBLE PRECISION NOT NULL DEFAULT 0,
  moving_seconds INTEGER NOT NULL DEFAULT 0,
  calories       INTEGER NOT NULL DEFAULT 0,
  area_gained_m2 DOUBLE PRECISION NOT NULL DEFAULT 0,
  area_lost_m2   DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The one that matters most: without it, every finished run sequentially scans
-- the whole territories table (which is what the old JS handler did in memory).
CREATE INDEX IF NOT EXISTS idx_territories_geom      ON territories USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_territories_user      ON territories (user_id);
CREATE INDEX IF NOT EXISTS idx_route_coords_session  ON route_coordinates (running_session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_user_date    ON running_sessions (user_id, local_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON running_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_locality     ON running_sessions (user_id, place_locality);
CREATE INDEX IF NOT EXISTS idx_stats_area            ON user_statistics (total_territory_area DESC);
CREATE INDEX IF NOT EXISTS idx_stats_distance        ON user_statistics (total_distance DESC);
CREATE INDEX IF NOT EXISTS idx_daily_user_date       ON user_daily_activity (user_id, local_date DESC);
CREATE INDEX IF NOT EXISTS idx_events_defender       ON territory_events (defender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_attacker       ON territory_events (attacker_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Auto-provision profile + stats when a Supabase auth user is created.
-- This is what makes signup atomic — the old authController created the user
-- and the stats row in two separate un-transacted steps, so a failure left a
-- user with no statistics row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base_username TEXT;
  final_username TEXT;
  suffix INTEGER := 0;
BEGIN
  -- Prefer an explicit username, then the OAuth display name, then the email
  -- local part. Google sends full_name/name; email/password signup sends
  -- username in raw_user_meta_data.
  base_username := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'username'), ''),
    NULLIF(TRIM(NEW.raw_user_meta_data->>'full_name'), ''),
    NULLIF(TRIM(NEW.raw_user_meta_data->>'name'), ''),
    NULLIF(SPLIT_PART(NEW.email, '@', 1), ''),
    'runner'
  );
  base_username := LEFT(REGEXP_REPLACE(base_username, '\s+', ' ', 'g'), 200);

  -- usernames are UNIQUE; de-duplicate rather than failing the signup
  final_username := base_username;
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = final_username) LOOP
    suffix := suffix + 1;
    final_username := base_username || ' ' || suffix;
  END LOOP;

  INSERT INTO public.profiles (id, username, avatar_url)
  VALUES (
    NEW.id,
    final_username,
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_statistics (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_touch ON profiles;
CREATE TRIGGER trg_profiles_touch BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_territories_touch ON territories;
CREATE TRIGGER trg_territories_touch BEFORE UPDATE ON territories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- The Express app connects with the service-role key, which BYPASSES all of
-- these, and enforces ownership in SQL itself. RLS is the defence-in-depth
-- backstop: it makes a leaked anon key harmless, and it is the ONLY protection
-- if the Phase 2 mobile app ever queries Supabase directly.
-- ---------------------------------------------------------------------------
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE running_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_coordinates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE territories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE territory_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_statistics      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_activity  ENABLE ROW LEVEL SECURITY;

-- profiles: everyone may read (the leaderboard shows usernames); you edit only your own
DROP POLICY IF EXISTS profiles_select_all ON profiles;
CREATE POLICY profiles_select_all ON profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles FOR UPDATE USING (auth.uid() = id);

-- running_sessions: strictly private
DROP POLICY IF EXISTS sessions_own ON running_sessions;
CREATE POLICY sessions_own ON running_sessions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- route_coordinates: private, via the owning session
DROP POLICY IF EXISTS coords_own ON route_coordinates;
CREATE POLICY coords_own ON route_coordinates
  FOR ALL USING (
    EXISTS (SELECT 1 FROM running_sessions s
             WHERE s.id = route_coordinates.running_session_id
               AND s.user_id = auth.uid())
  );

-- territories: world-readable (the map needs every polygon), owner-writable
DROP POLICY IF EXISTS territories_select_all ON territories;
CREATE POLICY territories_select_all ON territories FOR SELECT USING (true);
DROP POLICY IF EXISTS territories_write_own ON territories;
CREATE POLICY territories_write_own ON territories
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- territory_events: visible to the two parties involved
DROP POLICY IF EXISTS events_participant ON territory_events;
CREATE POLICY events_participant ON territory_events FOR SELECT
  USING (auth.uid() = attacker_user_id OR auth.uid() = defender_user_id);

-- user_statistics: world-readable for the leaderboard; writes are server-side only
DROP POLICY IF EXISTS stats_select_all ON user_statistics;
CREATE POLICY stats_select_all ON user_statistics FOR SELECT USING (true);

-- user_daily_activity: private
DROP POLICY IF EXISTS daily_own ON user_daily_activity;
CREATE POLICY daily_own ON user_daily_activity
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
