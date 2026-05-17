const { query } = require('../config/database');

/**
 * Insert a whole batch of GPS fixes in ONE query.
 *
 * This is the single biggest latency fix in the rewrite. The old endpoint took
 * one coordinate per HTTP request and performed a findById plus an insert plus
 * a synchronous console.log for each. With watchPosition firing about once a
 * second, a 30-minute run was ~1,800 round trips and ~3,600 queries.
 *
 * unnest() expands the parallel arrays into rows server-side, so the whole
 * batch costs one statement regardless of size.
 *
 * ON CONFLICT DO NOTHING against the (running_session_id, seq) unique
 * constraint makes the call idempotent: a retried batch, a double-fired
 * sendBeacon, or a mobile client replaying its offline queue cannot duplicate
 * the track or inflate the distance.
 */
async function insertBatch(sessionId, points) {
  if (!points || points.length === 0) return 0;

  const seqs = [];
  const lats = [];
  const lons = [];
  const accs = [];
  const pauses = [];
  const times = [];

  for (const p of points) {
    seqs.push(p.seq);
    lats.push(p.latitude);
    lons.push(p.longitude);
    accs.push(p.accuracy ?? null);
    pauses.push(Boolean(p.isPauseMarker));
    times.push(p.recordedAt ? new Date(p.recordedAt).toISOString() : new Date().toISOString());
  }

  const { rowCount } = await query(
    `INSERT INTO route_coordinates
       (running_session_id, seq, latitude, longitude, accuracy_m, is_pause_marker, recorded_at)
     SELECT $1, s, la, lo, ac, pa, ti
       FROM unnest(
              $2::int[], $3::float8[], $4::float8[],
              $5::float8[], $6::bool[], $7::timestamptz[]
            ) AS t(s, la, lo, ac, pa, ti)
     ON CONFLICT (running_session_id, seq) DO NOTHING`,
    [sessionId, seqs, lats, lons, accs, pauses, times]
  );

  return rowCount;
}

/** Ordered by seq, not recorded_at: seq is authoritative and gap-free. */
async function findBySession(sessionId) {
  const { rows } = await query(
    `SELECT seq, latitude, longitude, accuracy_m, is_pause_marker, recorded_at
       FROM route_coordinates
      WHERE running_session_id = $1
      ORDER BY seq ASC`,
    [sessionId]
  );
  return rows;
}

/** Highest seq so far, so a reconnecting client can resume without a collision. */
async function maxSeq(sessionId) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(seq), -1) AS max FROM route_coordinates WHERE running_session_id = $1',
    [sessionId]
  );
  return Number(rows[0].max);
}

async function countBySession(sessionId) {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS n FROM route_coordinates WHERE running_session_id = $1',
    [sessionId]
  );
  return rows[0].n;
}

module.exports = { insertBatch, findBySession, maxSeq, countBySession };
