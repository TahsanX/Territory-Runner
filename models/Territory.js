const { query } = require('../config/database');

/**
 * Zoom-dependent simplification tolerance, in degrees.
 *
 * At low zoom a territory is a few pixels across, so sending its full GPS
 * outline is wasted bytes. ST_SimplifyPreserveTopology keeps the shape valid
 * (plain ST_Simplify can produce self-intersections) while cutting payload
 * dramatically.
 */
function toleranceForZoom(zoom) {
  const z = Number(zoom) || 14;
  if (z >= 17) return 0;          // full fidelity up close
  if (z >= 15) return 0.000015;   // ~1.5 m
  if (z >= 13) return 0.00005;    // ~5 m
  if (z >= 11) return 0.0002;     // ~20 m
  return 0.001;                   // ~100 m
}

/**
 * Territories inside a viewport.
 *
 * Replaces the old unbounded `Territory.find()` which returned every territory
 * in the database, with full coordinate arrays, on every map load.
 *
 * `username` is returned ONLY for the requesting user's own territories.
 * Other runners' names are never selected, so they are absent from the
 * response rather than merely hidden in the UI.
 */
async function findInBounds({ minLat, maxLat, minLon, maxLon, zoom, userId, limit = 500 }) {
  const tol = toleranceForZoom(zoom);
  const { rows } = await query(
    `SELECT t.id,
            t.user_id,
            (t.user_id = $5)              AS is_own,
            CASE WHEN t.user_id = $5 THEN p.username END AS username,
            t.area_m2,
            t.label_lat,
            t.label_lon,
            t.created_at,
            ST_AsGeoJSON(CASE WHEN $6::float8 = 0 THEN t.geom
                              ELSE ST_SimplifyPreserveTopology(t.geom, $6::float8) END) AS geojson
       FROM territories t
       LEFT JOIN profiles p ON p.id = t.user_id
      WHERE t.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ORDER BY t.area_m2 DESC
      LIMIT $7`,
    [minLon, minLat, maxLon, maxLat, userId || null, tol, Math.min(limit, 2000)]
  );
  return rows.map(shape);
}

/** Global list, hard-limited. Used as the initial map load before a viewport exists. */
async function findRecent({ userId, limit = 200, zoom = 13 }) {
  const tol = toleranceForZoom(zoom);
  const { rows } = await query(
    `SELECT t.id,
            t.user_id,
            (t.user_id = $1)              AS is_own,
            CASE WHEN t.user_id = $1 THEN p.username END AS username,
            t.area_m2, t.label_lat, t.label_lon, t.created_at,
            ST_AsGeoJSON(CASE WHEN $2::float8 = 0 THEN t.geom
                              ELSE ST_SimplifyPreserveTopology(t.geom, $2::float8) END) AS geojson
       FROM territories t
       LEFT JOIN profiles p ON p.id = t.user_id
      ORDER BY t.created_at DESC
      LIMIT $3`,
    [userId || null, tol, Math.min(limit, 1000)]
  );
  return rows.map(shape);
}

async function findByUser(userId, limit = 200) {
  const { rows } = await query(
    `SELECT t.id, t.user_id, TRUE AS is_own, p.username,
            t.area_m2, t.label_lat, t.label_lon, t.created_at,
            ST_AsGeoJSON(t.geom) AS geojson
       FROM territories t
       LEFT JOIN profiles p ON p.id = t.user_id
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [userId, Math.min(limit, 1000)]
  );
  return rows.map(shape);
}

async function findById(territoryId, requesterId) {
  const { rows } = await query(
    `SELECT t.id, t.user_id,
            (t.user_id = $2) AS is_own,
            CASE WHEN t.user_id = $2 THEN p.username END AS username,
            t.area_m2, t.label_lat, t.label_lon, t.created_at,
            ST_AsGeoJSON(t.geom) AS geojson
       FROM territories t
       LEFT JOIN profiles p ON p.id = t.user_id
      WHERE t.id = $1`,
    [territoryId, requesterId || null]
  );
  return rows[0] ? shape(rows[0]) : null;
}

/**
 * Capture a territory and take every overlapping square metre from its current
 * owners, in one atomic call. All of the geometry lives in the SQL function —
 * see config/functions.sql for what the previous JS implementation got wrong.
 */
async function capture(client, { userId, sessionId, coords, localDate }) {
  const runner = client || { query: (...a) => query(...a) };
  const { rows } = await runner.query(
    `SELECT * FROM capture_territory($1, $2, $3::float8[][], $4::date)`,
    [userId, sessionId, coords, localDate || null]
  );
  if (!rows.length || rows[0].territory_id === null) return null;
  return {
    territoryId: Number(rows[0].territory_id),
    areaM2: Number(rows[0].area_m2),
    areaStolenM2: Number(rows[0].area_stolen_m2),
    victims: Number(rows[0].victims),
  };
}

function shape(row) {
  return {
    id: Number(row.id),
    isOwn: row.is_own === true,
    // Deliberately undefined for other runners' territories.
    username: row.username || undefined,
    area: Number(row.area_m2),
    labelLat: row.label_lat === null ? null : Number(row.label_lat),
    labelLon: row.label_lon === null ? null : Number(row.label_lon),
    createdAt: row.created_at,
    geometry: row.geojson ? JSON.parse(row.geojson) : null,
  };
}

module.exports = {
  findInBounds, findRecent, findByUser, findById, capture, toleranceForZoom,
};
