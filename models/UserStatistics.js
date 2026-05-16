const { query } = require('../config/database');

async function findByUser(userId) {
  const { rows } = await query(
    `SELECT user_id, total_distance, total_time, total_calories,
            total_territory_area, total_running_sessions, updated_at
       FROM user_statistics
      WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * One UPDATE for every running aggregate.
 *
 * The old finishSession called userStats.save() twice — once for the run
 * totals and again for the territory area — costing two round trips where one
 * does. Territory area is handled separately by capture_territory(), which
 * needs it inside the same transaction as the steal.
 */
async function addRun(client, userId, { distance, timeSeconds, calories }) {
  const runner = client || { query: (...a) => query(...a) };
  await runner.query(
    `INSERT INTO user_statistics AS s
       (user_id, total_distance, total_time, total_calories, total_running_sessions)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (user_id) DO UPDATE
        SET total_distance         = s.total_distance + EXCLUDED.total_distance,
            total_time             = s.total_time + EXCLUDED.total_time,
            total_calories         = s.total_calories + EXCLUDED.total_calories,
            total_running_sessions = s.total_running_sessions + 1,
            updated_at             = now()`,
    [userId, distance, timeSeconds, calories]
  );
}

/**
 * Leaderboard. `metric` is whitelisted, never interpolated from user input —
 * both columns have a dedicated DESC index.
 */
async function leaderboard(metric, limit = 10, offset = 0) {
  const column = metric === 'distance' ? 'total_distance' : 'total_territory_area';
  const { rows } = await query(
    `SELECT p.username,
            s.total_territory_area,
            s.total_distance,
            s.total_running_sessions,
            s.total_calories,
            RANK() OVER (ORDER BY s.${column} DESC) AS rank
       FROM user_statistics s
       JOIN profiles p ON p.id = s.user_id
      WHERE s.${column} > 0
      ORDER BY s.${column} DESC
      LIMIT $1 OFFSET $2`,
    [Math.min(limit, 100), offset]
  );
  return rows.map((r) => ({
    rank: Number(r.rank),
    username: r.username,
    total_territory_area: Number(r.total_territory_area),
    total_distance: Number(r.total_distance),
    total_running_sessions: Number(r.total_running_sessions),
    total_calories: Number(r.total_calories),
  }));
}

/**
 * A user's rank in one query.
 *
 * The old code issued a findOne followed by a countDocuments; this is a single
 * window function, and it returns the total player count too so the UI can
 * show "7th of 42" rather than a bare number.
 */
async function rankFor(userId, metric) {
  const column = metric === 'distance' ? 'total_distance' : 'total_territory_area';
  const { rows } = await query(
    `WITH ranked AS (
       SELECT user_id,
              ${column} AS value,
              RANK() OVER (ORDER BY ${column} DESC) AS rank,
              COUNT(*) OVER () AS total
         FROM user_statistics
     )
     SELECT rank, total, value FROM ranked WHERE user_id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  return {
    rank: Number(rows[0].rank),
    total: Number(rows[0].total),
    value: Number(rows[0].value),
  };
}

module.exports = { findByUser, addRun, leaderboard, rankFor };
