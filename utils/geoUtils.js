// Scoped Turf imports. `require('@turf/turf')` pulled the entire ~500 KB
// library in for six functions; only distance is still needed here, because
// all polygon geometry moved into PostGIS (see config/functions.sql).
const distance = require('@turf/distance').default;
const { point } = require('@turf/helpers');

const CLOSED_LOOP_METRES = 50;

/**
 * A track is a closed loop when its first and last fix are within 50 m.
 *
 * Pause handling no longer involves scanning for a [999, 999] sentinel: pauses
 * are a boolean column on route_coordinates, so callers pass only real fixes.
 */
function isClosedLoop(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 3) return false;

  const start = point([coordinates[0][1], coordinates[0][0]]);
  const last = coordinates[coordinates.length - 1];
  const end = point([last[1], last[0]]);

  return distance(start, end, { units: 'meters' }) <= CLOSED_LOOP_METRES;
}

/** Metres between two [lat, lon] pairs. */
function metresBetween(a, b) {
  return distance(point([a[1], a[0]]), point([b[1], b[0]]), { units: 'meters' });
}

/**
 * Distance, moving time and calories.
 *
 * Two changes from the previous version:
 *   - weightKg is a parameter sourced from the user's profile, instead of 70
 *     being hardcoded in the formula
 *   - time is MOVING time: paused segments are excluded, so a run that was
 *     paused for ten minutes no longer reports a ten-minute-longer duration
 *
 * Calories use the standard net-energy approximation
 * 0.63 kcal per kg per km.
 */
function calculateRunningStats(points, { weightKg = 70 } = {}) {
  let totalKm = 0;
  let movingSeconds = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];

    // Don't bridge a pause: neither the distance nor the elapsed time across
    // the gap belongs to the run.
    if (a.isPauseMarker || b.isPauseMarker) continue;

    totalKm += distance(
      point([a.longitude, a.latitude]),
      point([b.longitude, b.latitude]),
      { units: 'kilometers' }
    );

    if (a.recordedAt && b.recordedAt) {
      const gap = (new Date(b.recordedAt) - new Date(a.recordedAt)) / 1000;
      // A gap over 2 minutes means lost signal or a backgrounded tab, not
      // running; counting it would inflate the duration.
      if (gap > 0 && gap < 120) movingSeconds += gap;
    }
  }

  const distanceKm = Number(totalKm.toFixed(4));

  return {
    distance: distanceKm,
    calories: Math.round(distanceKm * weightKg * 0.63),
    time: Math.round(movingSeconds),
  };
}

/** Bounding box of a track, for the reverse-geocode lookup and map fitting. */
function boundsOf(points) {
  if (!points.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const p of points) {
    const lat = p.latitude ?? p[0];
    const lon = p.longitude ?? p[1];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return {
    minLat, maxLat, minLon, maxLon,
    centreLat: (minLat + maxLat) / 2,
    centreLon: (minLon + maxLon) / 2,
  };
}

module.exports = {
  isClosedLoop,
  metresBetween,
  calculateRunningStats,
  boundsOf,
  CLOSED_LOOP_METRES,
};
