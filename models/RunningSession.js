const { query } = require('../config/database');

async function create(userId, { localDate, tzOffsetMinutes } = {}) {
  const { rows } = await query(
    `INSERT INTO running_sessions (user_id, start_time, local_date, tz_offset_minutes)
     VALUES ($1, now(), $2, $3)
     RETURNING id, user_id, start_time, local_date`,
    [userId, localDate || null, tzOffsetMinutes ?? null]
  );
  return rows[0];
}

/**
 * Always scoped by user_id.
 *
 * The previous implementation looked sessions up by id alone across every run
 * endpoint, so any authenticated user could add coordinates to, finish, or read
 * another user's session — and finishSession assigned the resulting territory
 * to req.user.id, meaning you could claim someone else's run.
 */
async function findOwnedById(sessionId, userId) {
  const { rows } = await query(
    `SELECT id, user_id, start_time, end_time, is_closed_loop,
            total_distance, total_time, estimated_calories,
            place_name, place_locality, local_date, tz_offset_minutes
       FROM running_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

async function finalize(sessionId, userId, fields) {
  const {
    endTime, isClosedLoop, totalDistance, totalTime,
    estimatedCalories, placeName, placeLocality, localDate,
  } = fields;

  const { rows } = await query(
    `UPDATE running_sessions
        SET end_time           = $3,
            is_closed_loop     = $4,
            total_distance     = $5,
            total_time         = $6,
            estimated_calories = $7,
            place_name         = COALESCE($8, place_name),
            place_locality     = COALESCE($9, place_locality),
            local_date         = COALESCE($10, local_date, CURRENT_DATE)
      WHERE id = $1 AND user_id = $2
      RETURNING *`,
    [sessionId, userId, endTime, isClosedLoop, totalDistance, totalTime,
     estimatedCalories, placeName || null, placeLocality || null, localDate || null]
  );
  return rows[0] || null;
}

async function setPlace(sessionId, { placeName, placeLocality }) {
  await query(
    `UPDATE running_sessions SET place_name = $2, place_locality = $3 WHERE id = $1`,
    [sessionId, placeName || null, placeLocality || null]
  );
}

async function history(userId, limit = 20, offset = 0) {
  const { rows } = await query(
    `SELECT s.id, s.start_time, s.end_time, s.is_closed_loop,
            s.total_distance, s.total_time, s.estimated_calories,
            s.place_name, s.place_locality, s.local_date, s.created_at,
            t.id AS territory_id, t.area_m2 AS territory_area
       FROM running_sessions s
       LEFT JOIN territories t ON t.running_session_id = s.id
      WHERE s.user_id = $1 AND s.end_time IS NOT NULL
      ORDER BY s.created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, Math.min(limit, 100), offset]
  );
  return rows;
}

module.exports = { create, findOwnedById, finalize, setPlace, history };
