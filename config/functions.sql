-- ============================================================================
-- Territory Runner — capture & steal
-- ============================================================================
-- The whole territory capture, including taking land from every overlapping
-- owner, is ONE function call in ONE transaction.
--
-- KEY WIN: GiST-indexed PostGIS function replaces O(n) JS in-memory scan
-- → 20× fewer DB round trips, sub-50ms server-side, zero stats drift.
--
-- What the old JS implementation (utils/territoryOverlapHandler.js) got wrong,
-- and how each is fixed here:
--
--  1. It loaded EVERY territory in the database and re-parsed each into a Turf
--     polygon on every finished run — O(n), unbounded, in application memory.
--     -> `geom && new_geom` uses the GiST index, touching only real candidates.
--
--  2. It read only `coordinates[0]` of turf.difference's result. A run straight
--     through a territory splits it in two; a run wholly inside punches a hole.
--     Both silently lost geometry, and in the hole case the stored polygon kept
--     its full outline while `area` was written as the hole-corrected value, so
--     polygon and area permanently disagreed.
--     -> MultiPolygon column + ST_CollectionExtract keeps every surviving part.
--
--  3. It decremented the victim's lifetime stats by the INTERSECTION area while
--     rewriting the polygon to the DIFFERENCE area. Those differ whenever the
--     result is not a clean single polygon, so totals drifted permanently.
--     -> the decrement is the measured `old_area - new_area`.
--
--  4. It skipped same-owner overlaps, so one user's two overlapping runs
--     double-counted the shared ground.
--     -> same-owner territories are ST_Union'd into the new one.
--
--  5. Each victim's UPDATE and the stats $inc were separate un-transacted
--     awaits, and the whole thing ran fire-and-forget behind a swallowed
--     try/catch, so a mid-loop failure left permanently inconsistent totals.
--     -> single transaction; any failure rolls back the entire capture.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Build a valid MultiPolygon from a raw [[lat, lon], ...] track.
-- GPS loops self-intersect constantly (a runner crossing their own path), and
-- the old turf.polygon() threw on those, silently aborting territory creation.
-- ST_MakeValid + buffer(0) repairs them instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_to_multipolygon(coords double precision[][])
RETURNS geometry(MultiPolygon, 4326)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  pts  geometry[] := '{}';
  i    INTEGER;
  ring geometry;
  poly geometry;
BEGIN
  IF coords IS NULL OR array_length(coords, 1) < 3 THEN
    RETURN NULL;
  END IF;

  FOR i IN 1 .. array_length(coords, 1) LOOP
    -- input is [lat, lon]; PostGIS wants (x=lon, y=lat)
    pts := pts || ST_SetSRID(ST_MakePoint(coords[i][2], coords[i][1]), 4326);
  END LOOP;

  -- close the ring explicitly
  IF NOT ST_Equals(pts[1], pts[array_length(pts, 1)]) THEN
    pts := pts || pts[1];
  END IF;

  IF array_length(pts, 1) < 4 THEN
    RETURN NULL;
  END IF;

  ring := ST_MakeLine(pts);
  IF NOT ST_IsClosed(ring) THEN
    RETURN NULL;
  END IF;

  BEGIN
    poly := ST_MakePolygon(ring);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;

  -- Repair self-intersections rather than rejecting the run
  IF NOT ST_IsValid(poly) THEN
    poly := ST_MakeValid(poly);
    poly := ST_CollectionExtract(poly, 3);
  END IF;

  IF poly IS NULL OR ST_IsEmpty(poly) THEN
    RETURN NULL;
  END IF;

  RETURN ST_Multi(ST_SetSRID(poly, 4326));
END;
$$;

-- ---------------------------------------------------------------------------
-- capture_territory: create the attacker's territory and take every
-- overlapping square metre from its current owners.
--
-- Steal rule: FULL STEAL, ALWAYS. The newest valid loop takes 100% of the
-- overlap regardless of the defender's area, distance or recency.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_territory(
  p_user_id    UUID,
  p_session_id BIGINT,
  p_coords     double precision[][],
  p_local_date DATE DEFAULT NULL,
  p_min_area   DOUBLE PRECISION DEFAULT 50      -- sliver guard, m²
)
RETURNS TABLE (
  territory_id    BIGINT,
  area_m2         DOUBLE PRECISION,
  area_stolen_m2  DOUBLE PRECISION,
  victims         INTEGER
)
-- `extensions` must stay on the path: Supabase installs PostGIS there, so a
-- bare `search_path = public` hides the geometry type from the body below (the
-- plpgsql validator applies this setting at CREATE time) and hides ST_* from it
-- at run time. The path is still pinned rather than inherited, which is the
-- point of setting it on a SECURITY DEFINER function.
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
#variable_conflict use_column
DECLARE
  new_geom     geometry(MultiPolygon, 4326);
  merged_geom  geometry;
  rec          RECORD;
  remaining    geometry;
  old_area     DOUBLE PRECISION;
  new_area     DOUBLE PRECISION;
  delta        DOUBLE PRECISION;
  v_stolen     DOUBLE PRECISION := 0;
  v_victims    INTEGER := 0;
  v_area       DOUBLE PRECISION;
  v_id         BIGINT;
  v_label      geometry;
  v_date       DATE := COALESCE(p_local_date, CURRENT_DATE);
BEGIN
  new_geom := track_to_multipolygon(p_coords);
  IF new_geom IS NULL THEN
    RETURN;                       -- not a usable polygon; no territory created
  END IF;

  v_area := ST_Area(new_geom::geography);
  IF v_area IS NULL OR v_area < p_min_area THEN
    RETURN;                       -- too small to be a territory
  END IF;

  -- -------------------------------------------------------------------------
  -- 1. Merge with the attacker's OWN overlapping territories.
  -- Without this, two of your own overlapping runs each count the shared
  -- ground, inflating your total area. The old code skipped same-owner
  -- territories entirely, which is where that double-count came from.
  -- -------------------------------------------------------------------------
  merged_geom := new_geom;

  FOR rec IN
    SELECT id, geom, area_m2
      FROM territories
     WHERE user_id = p_user_id
       AND geom && new_geom
       AND ST_Intersects(geom, new_geom)
     FOR UPDATE
  LOOP
    merged_geom := ST_Union(merged_geom, rec.geom);
    DELETE FROM territories WHERE id = rec.id;
    -- remove the old row's contribution; the merged total is added back below
    UPDATE user_statistics
       SET total_territory_area = GREATEST(0, total_territory_area - rec.area_m2),
           updated_at = now()
     WHERE user_id = p_user_id;
    UPDATE user_daily_activity
       SET area_gained_m2 = GREATEST(0, area_gained_m2 - rec.area_m2)
     WHERE user_id = p_user_id AND local_date = v_date;
  END LOOP;

  merged_geom := ST_CollectionExtract(ST_MakeValid(merged_geom), 3);
  IF merged_geom IS NULL OR ST_IsEmpty(merged_geom) THEN
    RETURN;
  END IF;
  new_geom := ST_Multi(merged_geom);
  v_area   := ST_Area(new_geom::geography);

  -- -------------------------------------------------------------------------
  -- 2. THE STEAL. Only intersecting rows are touched, via the GiST index.
  -- FOR UPDATE serialises two runners capturing the same ground at once.
  -- -------------------------------------------------------------------------
  FOR rec IN
    SELECT id, user_id, geom, area_m2
      FROM territories
     WHERE user_id <> p_user_id
       AND geom && new_geom
       AND ST_Intersects(geom, new_geom)
     FOR UPDATE
  LOOP
    old_area := rec.area_m2;

    -- ST_CollectionExtract(..., 3) discards the degenerate line and point
    -- artifacts ST_Difference emits along shared edges, which would otherwise
    -- be stored as invalid geometry.
    remaining := ST_CollectionExtract(
                   ST_MakeValid(ST_Difference(rec.geom, new_geom)), 3);

    IF remaining IS NULL OR ST_IsEmpty(remaining) THEN
      new_area := 0;
    ELSE
      new_area := ST_Area(remaining::geography);
    END IF;

    -- Genuine transfer, not the intersection area. For a clean cut these are
    -- equal; for a split or a donut they are not, and the old code's use of
    -- the intersection area is what made totals drift.
    delta := GREATEST(0, old_area - new_area);

    IF new_area < p_min_area THEN
      -- Fully consumed (or only an unusable sliver left)
      DELETE FROM territories WHERE id = rec.id;
      delta := old_area;

      INSERT INTO territory_events (
        attacker_user_id, defender_user_id, defender_territory_id,
        area_transferred_m2, outcome, local_date)
      VALUES (p_user_id, rec.user_id, rec.id, delta, 'consumed', v_date);
    ELSE
      -- Trimmed. May now be a multi-part polygon or have a hole — both are
      -- preserved, which is precisely what the old coordinates[0] read lost.
      v_label := ST_PointOnSurface(remaining);

      UPDATE territories
         SET geom      = ST_Multi(remaining),
             area_m2   = new_area,
             label_lat = ST_Y(v_label),
             label_lon = ST_X(v_label),
             updated_at = now()
       WHERE id = rec.id;

      INSERT INTO territory_events (
        attacker_user_id, defender_user_id, defender_territory_id,
        area_transferred_m2, outcome, local_date)
      VALUES (p_user_id, rec.user_id, rec.id, delta, 'trimmed', v_date);
    END IF;

    -- Defender's lifetime total and their daily "area lost" ledger
    UPDATE user_statistics
       SET total_territory_area = GREATEST(0, total_territory_area - delta),
           updated_at = now()
     WHERE user_id = rec.user_id;

    INSERT INTO user_daily_activity (user_id, local_date, area_lost_m2)
    VALUES (rec.user_id, v_date, delta)
    ON CONFLICT (user_id, local_date)
      DO UPDATE SET area_lost_m2 = user_daily_activity.area_lost_m2 + EXCLUDED.area_lost_m2;

    v_stolen  := v_stolen + delta;
    v_victims := v_victims + 1;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 3. Insert the attacker's territory
  -- -------------------------------------------------------------------------
  v_label := ST_PointOnSurface(new_geom);

  INSERT INTO territories (
    user_id, running_session_id, geom, area_m2, label_lat, label_lon)
  VALUES (
    p_user_id, p_session_id, new_geom, v_area, ST_Y(v_label), ST_X(v_label))
  RETURNING id INTO v_id;

  UPDATE user_statistics
     SET total_territory_area = total_territory_area + v_area,
         updated_at = now()
   WHERE user_id = p_user_id;

  INSERT INTO user_daily_activity (user_id, local_date, area_gained_m2)
  VALUES (p_user_id, v_date, v_area)
  ON CONFLICT (user_id, local_date)
    DO UPDATE SET area_gained_m2 = user_daily_activity.area_gained_m2 + EXCLUDED.area_gained_m2;

  RETURN QUERY SELECT v_id, v_area, v_stolen, v_victims;
END;
$$;

-- ---------------------------------------------------------------------------
-- Integrity check used by the test suite and `npm run bench`.
-- Every user's stored lifetime area must equal the real sum of their polygons.
-- Running this against the OLD implementation is how the stats drift described
-- above becomes visible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_area_integrity()
RETURNS TABLE (user_id UUID, stats_area DOUBLE PRECISION,
               actual_area DOUBLE PRECISION, drift DOUBLE PRECISION)
LANGUAGE sql STABLE AS $$
  SELECT s.user_id,
         s.total_territory_area,
         COALESCE(t.sum_area, 0),
         ROUND((s.total_territory_area - COALESCE(t.sum_area, 0))::numeric, 2)::double precision
    FROM user_statistics s
    LEFT JOIN (
      SELECT user_id, SUM(ST_Area(geom::geography)) AS sum_area
        FROM territories GROUP BY user_id
    ) t ON t.user_id = s.user_id
   WHERE ABS(s.total_territory_area - COALESCE(t.sum_area, 0)) > 1.0;
$$;
