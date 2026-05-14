const logger = require('./logger');

/**
 * Reverse-geocode a coordinate into a place name, ONCE per finished run.
 *
 * The result is cached on running_sessions.place_name / place_locality, so the
 * "places I visited most" summary is a GROUP BY over stored strings rather
 * than an API call per summary view. Geocoding on demand would rate-limit on
 * Nominatim almost immediately.
 *
 * Every failure path returns null. A place name is a nice-to-have; it must
 * never fail a run or block the finish response.
 */

const PROVIDER = (process.env.GEOCODER_PROVIDER || 'nominatim').toLowerCase();
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'TerritoryRunner/2.0';
const TIMEOUT_MS = 4000;

// Nominatim's usage policy allows at most 1 request/second. We finish runs far
// less often than that, but a seeding script or a burst of finishes could trip
// it, so the limit is enforced here rather than hoped for.
let lastCall = 0;
const MIN_INTERVAL_MS = 1100;

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function viaNominatim(lat, lon) {
  await throttle();
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
    `&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`;
  const data = await fetchJson(url, { 'User-Agent': USER_AGENT });
  const a = data?.address || {};
  // Prefer the most human-meaningful level available: a runner thinks in
  // neighbourhoods, not in administrative regions.
  const locality =
    a.suburb || a.neighbourhood || a.quarter || a.village ||
    a.town || a.city_district || a.city || a.county || null;
  return {
    placeName: data?.display_name ? data.display_name.split(',').slice(0, 2).join(',').trim() : null,
    placeLocality: locality,
  };
}

async function viaGeoapify(lat, lon) {
  const key = process.env.GEOAPIFY_KEY;
  if (!key) return null;
  // No `type` filter: Geoapify only accepts country/state/city/postcode/street/
  // amenity/locality/building, so the obvious-looking `type=neighbourhood` made
  // every call a 400. `locality` returns nothing in much of Dhaka, so the
  // default (nearest feature) is used and the neighbourhood is read off the
  // address fields below instead.
  const url =
    `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lon}` +
    `&format=json&apiKey=${key}`;
  const data = await fetchJson(url);
  const r = data?.results?.[0];
  if (!r) return null;
  return {
    placeName: r.address_line1 || r.formatted || null,
    placeLocality:
      r.suburb || r.quarter || r.district || r.city || r.town ||
      r.village || r.county || null,
  };
}

async function reverseGeocode(lat, lon) {
  if (PROVIDER === 'none') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  try {
    const result = PROVIDER === 'geoapify'
      ? await viaGeoapify(lat, lon)
      : await viaNominatim(lat, lon);

    if (!result || (!result.placeName && !result.placeLocality)) return null;
    return result;
  } catch (err) {
    logger.debug({ err: err.message, lat, lon }, 'Reverse geocode failed');
    return null;
  }
}

module.exports = { reverseGeocode };
