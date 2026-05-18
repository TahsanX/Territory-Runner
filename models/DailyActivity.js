const { query } = require('../config/database');

/**
 * One row per user per LOCAL day. Written once when a run finishes, so the
 * streak calendar and both summaries are indexed range scans rather than
 * aggregates over raw sessions on every page load.
 */

async function recordRun(client, userId, localDate, { distanceKm, movingSeconds, calories }) {
  const runner = client || { query: (...a) => query(...a) };
  await runner.query(
    `INSERT INTO user_daily_activity AS d
       (user_id, local_date, runs, distance_km, moving_seconds, calories)
     VALUES ($1, $2, 1, $3, $4, $5)
     ON CONFLICT (user_id, local_date) DO UPDATE
        SET runs           = d.runs + 1,
            distance_km    = d.distance_km + EXCLUDED.distance_km,
            moving_seconds = d.moving_seconds + EXCLUDED.moving_seconds,
            calories       = d.calories + EXCLUDED.calories`,
    [userId, localDate, distanceKm, movingSeconds, calories]
  );
}

async function forRange(userId, from, to) {
  const { rows } = await query(
    `SELECT local_date, runs, distance_km, moving_seconds, calories,
            area_gained_m2, area_lost_m2
       FROM user_daily_activity
      WHERE user_id = $1 AND local_date BETWEEN $2 AND $3
      ORDER BY local_date ASC`,
    [userId, from, to]
  );
  return rows.map((r) => ({
    date: r.local_date instanceof Date ? r.local_date.toISOString().slice(0, 10) : r.local_date,
    runs: r.runs,
    distanceKm: Number(r.distance_km),
    movingSeconds: r.moving_seconds,
    calories: r.calories,
    areaGainedM2: Number(r.area_gained_m2),
    areaLostM2: Number(r.area_lost_m2),
  }));
}

/**
 * Intensity thresholds from the quantiles of this user's OWN active days.
 *
 * Fixed thresholds would make the calendar useless for somebody whose normal
 * run is 2 km and equally useless for somebody running 20 km — everything
 * lands in one bucket either way. Quantiles keep all four levels meaningful
 * whatever the runner's range.
 */
async function intensityThresholds(userId) {
  const { rows } = await query(
    `SELECT PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY distance_km) AS q1,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY distance_km) AS q2,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY distance_km) AS q3,
            COUNT(*)::int AS n
       FROM user_daily_activity
      WHERE user_id = $1 AND distance_km > 0`,
    [userId]
  );
  const r = rows[0];
  // Below ~4 active days the quantiles are noise; fall back to sane defaults.
  if (!r || r.n < 4) return { q1: 1, q2: 3, q3: 6, bootstrapped: true };
  return {
    q1: Number(r.q1), q2: Number(r.q2), q3: Number(r.q3), bootstrapped: false,
  };
}

/**
 * Current and longest streak, in the user's local dates.
 *
 * Uses the classic gaps-and-islands trick: subtracting a dense row number from
 * each date makes consecutive days share a constant, so each run of days
 * becomes one group. That is a single pass in SQL instead of pulling every
 * active day into Node and looping.
 *
 * "Current" tolerates today having no run yet — a streak is only broken once
 * a whole day has passed, otherwise it would read as broken every morning.
 */
async function streaks(userId, today) {
  const { rows } = await query(
    `WITH days AS (
       SELECT local_date
         FROM user_daily_activity
        WHERE user_id = $1 AND runs > 0
        ORDER BY local_date
     ), grouped AS (
       SELECT local_date,
              local_date - (ROW_NUMBER() OVER (ORDER BY local_date))::int AS grp
         FROM days
     ), runs AS (
       SELECT grp, MIN(local_date) AS started, MAX(local_date) AS ended,
              COUNT(*)::int AS length
         FROM grouped GROUP BY grp
     )
     SELECT
       (SELECT MAX(length) FROM runs) AS longest,
       (SELECT length FROM runs
          WHERE ended >= $2::date - INTERVAL '1 day'
          ORDER BY ended DESC LIMIT 1) AS current,
       (SELECT started FROM runs ORDER BY length DESC, ended DESC LIMIT 1) AS longest_started,
       (SELECT ended   FROM runs ORDER BY length DESC, ended DESC LIMIT 1) AS longest_ended`,
    [userId, today]
  );
  const r = rows[0] || {};
  return {
    current: Number(r.current || 0),
    longest: Number(r.longest || 0),
    longestStarted: r.longest_started || null,
    longestEnded: r.longest_ended || null,
  };
}

/** Longest streak confined to a single window — "longest streak in the month". */
async function longestStreakInRange(userId, from, to) {
  const { rows } = await query(
    `WITH days AS (
       SELECT local_date FROM user_daily_activity
        WHERE user_id = $1 AND runs > 0 AND local_date BETWEEN $2 AND $3
        ORDER BY local_date
     ), grouped AS (
       SELECT local_date,
              local_date - (ROW_NUMBER() OVER (ORDER BY local_date))::int AS grp
         FROM days
     )
     SELECT COALESCE(MAX(c), 0)::int AS longest
       FROM (SELECT COUNT(*) AS c FROM grouped GROUP BY grp) x`,
    [userId, from, to]
  );
  return Number(rows[0]?.longest || 0);
}

/** Aggregate totals for a month or a year. */
async function summaryTotals(userId, from, to) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(runs), 0)::int              AS runs,
            COALESCE(SUM(distance_km), 0)            AS distance_km,
            COALESCE(SUM(moving_seconds), 0)::int    AS moving_seconds,
            COALESCE(SUM(calories), 0)::int          AS calories,
            COALESCE(SUM(area_gained_m2), 0)         AS area_gained_m2,
            COALESCE(SUM(area_lost_m2), 0)           AS area_lost_m2,
            COUNT(*) FILTER (WHERE runs > 0)::int    AS active_days
       FROM user_daily_activity
      WHERE user_id = $1 AND local_date BETWEEN $2 AND $3`,
    [userId, from, to]
  );
  const r = rows[0];
  return {
    runs: r.runs,
    distanceKm: Number(r.distance_km),
    movingSeconds: r.moving_seconds,
    calories: r.calories,
    areaGainedM2: Number(r.area_gained_m2),
    areaLostM2: Number(r.area_lost_m2),
    activeDays: r.active_days,
  };
}

module.exports = {
  recordRun, forRange, intensityThresholds, streaks,
  longestStreakInRange, summaryTotals,
};
