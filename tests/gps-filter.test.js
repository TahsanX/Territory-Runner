/**
 * GPS filter tests.
 *
 * These cover exactly the cases the previous build got wrong, because it never
 * read position.coords.accuracy at all:
 *   - a clean track is preserved
 *   - a 2 km spike is rejected rather than drawn and counted
 *   - standing still accumulates ~0 distance instead of drift
 *   - cold-start fixes are discarded
 *
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const GpsFilter = require('../shared/gps-filter');

const BASE = { lat: 23.8103, lon: 90.4125 };
const START = 1_700_000_000_000;

/** Metres east, converted to degrees of longitude at this latitude. */
function eastOf(metres) {
  return BASE.lon + metres / (111_320 * Math.cos(BASE.lat * Math.PI / 180));
}

/** A straight track heading east at a steady pace. */
function straightTrack(count, metresApart, secondsApart, accuracy = 8) {
  const fixes = [];
  for (let i = 0; i < count; i++) {
    fixes.push({
      latitude: BASE.lat,
      longitude: eastOf(i * metresApart),
      accuracy,
      timestamp: START + i * secondsApart * 1000,
    });
  }
  return fixes;
}

function runAll(filter, fixes) {
  return fixes.map((f) => filter.accept(f));
}

test('accepts a clean track after the warm-up fixes', () => {
  const filter = new GpsFilter();
  const results = runAll(filter, straightTrack(20, 10, 2));

  // 3 discarded as warm-up, the rest accepted.
  assert.strictEqual(filter.stats.rejectedWarmup, 3);
  assert.strictEqual(filter.stats.accepted, 17);
  assert.ok(results.slice(3).every((r) => r.accepted));
});

test('rejects fixes that are too imprecise', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 0 });
  const result = filter.accept({
    latitude: BASE.lat, longitude: BASE.lon, accuracy: 120, timestamp: START,
  });

  assert.strictEqual(result.accepted, false);
  assert.strictEqual(result.reason, GpsFilter.REASONS.INACCURATE);
  assert.strictEqual(filter.stats.rejectedAccuracy, 1);
});

test('rejects a 2 km urban-canyon spike and keeps the real position', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 0 });

  filter.accept({ latitude: BASE.lat, longitude: BASE.lon, accuracy: 6, timestamp: START });
  filter.accept({ latitude: BASE.lat, longitude: eastOf(10), accuracy: 6, timestamp: START + 2000 });

  // 2 km in 2 seconds is 1000 m/s — the exact failure the old code recorded.
  const spike = filter.accept({
    latitude: BASE.lat, longitude: eastOf(2010), accuracy: 6, timestamp: START + 4000,
  });
  assert.strictEqual(spike.accepted, false);
  assert.strictEqual(spike.reason, GpsFilter.REASONS.TOO_FAST);

  // Critically, `last` must NOT have moved to the spike, or the next genuine
  // fix would itself look like an impossible 2 km jump back.
  const recovery = filter.accept({
    latitude: BASE.lat, longitude: eastOf(20), accuracy: 6, timestamp: START + 6000,
  });
  assert.strictEqual(recovery.accepted, true);
});

test('standing still accumulates no meaningful distance', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 0 });
  let total = 0;
  let prev = null;

  // 60 fixes of pure jitter within ~2 m, as if waiting at a traffic light.
  for (let i = 0; i < 60; i++) {
    const jitterLat = BASE.lat + (Math.sin(i) * 1.5) / 111_320;
    const jitterLon = eastOf(Math.cos(i) * 1.5);
    const r = filter.accept({
      latitude: jitterLat, longitude: jitterLon, accuracy: 7, timestamp: START + i * 1000,
    });
    if (r.accepted) {
      if (prev) {
        total += GpsFilter.haversineMetres(
          prev.latitude, prev.longitude, r.point.latitude, r.point.longitude);
      }
      prev = r.point;
    }
  }

  // The old code would have summed every one of these jitters into the total.
  assert.ok(total < 15, `standing still accumulated ${total.toFixed(1)} m`);
});

test('discards cold-start fixes', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 3 });
  const fixes = straightTrack(5, 10, 2);

  assert.strictEqual(filter.accept(fixes[0]).reason, GpsFilter.REASONS.WARMUP);
  assert.strictEqual(filter.accept(fixes[1]).reason, GpsFilter.REASONS.WARMUP);
  assert.strictEqual(filter.accept(fixes[2]).reason, GpsFilter.REASONS.WARMUP);
  assert.strictEqual(filter.accept(fixes[3]).accepted, true);
});

test('warm-up counts only otherwise-valid fixes', () => {
  // A run starting with bad fixes should not then also lose three good ones.
  const filter = new GpsFilter({ warmupDiscardCount: 2 });

  filter.accept({ latitude: BASE.lat, longitude: BASE.lon, accuracy: 200, timestamp: START });
  filter.accept({ latitude: BASE.lat, longitude: BASE.lon, accuracy: 300, timestamp: START + 1000 });
  assert.strictEqual(filter.stats.rejectedWarmup, 0, 'inaccurate fixes must not consume the warm-up');

  filter.accept({ latitude: BASE.lat, longitude: eastOf(10), accuracy: 6, timestamp: START + 2000 });
  filter.accept({ latitude: BASE.lat, longitude: eastOf(20), accuracy: 6, timestamp: START + 4000 });
  assert.strictEqual(filter.stats.rejectedWarmup, 2);
});

test('rejects invalid coordinates, including the old [999, 999] sentinel', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 0 });

  assert.strictEqual(filter.accept({ latitude: 999, longitude: 999 }).reason,
                     GpsFilter.REASONS.INVALID);
  assert.strictEqual(filter.accept({ latitude: NaN, longitude: 0 }).reason,
                     GpsFilter.REASONS.INVALID);
  assert.strictEqual(filter.accept({ latitude: 0, longitude: 200 }).reason,
                     GpsFilter.REASONS.INVALID);
});

test('reset clears state so a resumed run does not see a false jump', () => {
  const filter = new GpsFilter({ warmupDiscardCount: 0 });
  filter.accept({ latitude: BASE.lat, longitude: BASE.lon, accuracy: 6, timestamp: START });

  filter.reset();
  assert.strictEqual(filter.last, null);
  assert.strictEqual(filter.stats.accepted, 0);

  // After a pause the runner may legitimately be somewhere else entirely.
  const after = filter.accept({
    latitude: BASE.lat, longitude: eastOf(5000), accuracy: 6, timestamp: START + 1000,
  });
  assert.strictEqual(after.accepted, true);
});

test('quality bands match the accuracy gate', () => {
  const filter = new GpsFilter();
  assert.strictEqual(filter.quality(5), 'excellent');
  assert.strictEqual(filter.quality(12), 'good');
  assert.strictEqual(filter.quality(22), 'fair');
  assert.strictEqual(filter.quality(80), 'poor');
  assert.strictEqual(filter.quality(null), 'unknown');
});

test('haversine is accurate over a short distance', () => {
  // One degree of latitude is ~111.2 km.
  const d = GpsFilter.haversineMetres(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111_195) < 500, `got ${d}`);
});
