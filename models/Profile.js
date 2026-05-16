const { query } = require('../config/database');

/** Replaces the Mongoose User model. Identity itself lives in Supabase auth.users. */

async function findById(userId) {
  const { rows } = await query(
    `SELECT id, username, avatar_url, weight_kg, created_at
       FROM profiles
      WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function findWithStats(userId) {
  const { rows } = await query(
    `SELECT p.id, p.username, p.avatar_url, p.weight_kg, p.created_at,
            COALESCE(s.total_distance, 0)         AS total_distance,
            COALESCE(s.total_time, 0)             AS total_time,
            COALESCE(s.total_calories, 0)         AS total_calories,
            COALESCE(s.total_territory_area, 0)   AS total_territory_area,
            COALESCE(s.total_running_sessions, 0) AS total_running_sessions
       FROM profiles p
       LEFT JOIN user_statistics s ON s.user_id = p.id
      WHERE p.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * The profile is normally created by the on_auth_user_created trigger. This is
 * the safety net for a user who signed up before the trigger existed.
 */
async function ensureExists(userId, { username, avatarUrl } = {}) {
  const fallback = username || `runner-${String(userId).slice(0, 8)}`;
  const { rows } = await query(
    `INSERT INTO profiles (id, username, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE
        SET avatar_url = COALESCE(profiles.avatar_url, EXCLUDED.avatar_url)
     RETURNING id, username, avatar_url, weight_kg, created_at`,
    [userId, fallback, avatarUrl || null]
  );
  await query(
    `INSERT INTO user_statistics (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  return rows[0];
}

async function update(userId, { username, weightKg, avatarUrl }) {
  const { rows } = await query(
    `UPDATE profiles
        SET username   = COALESCE($2, username),
            weight_kg  = COALESCE($3, weight_kg),
            avatar_url = COALESCE($4, avatar_url)
      WHERE id = $1
      RETURNING id, username, avatar_url, weight_kg, created_at`,
    [userId, username || null, weightKg ?? null, avatarUrl || null]
  );
  return rows[0] || null;
}

/** Weight drives the calorie estimate, which used to be hardcoded at 70 kg. */
async function getWeightKg(userId) {
  const { rows } = await query('SELECT weight_kg FROM profiles WHERE id = $1', [userId]);
  return rows[0] ? Number(rows[0].weight_kg) : 70;
}

module.exports = { findById, findWithStats, ensureExists, update, getWeightKg };
