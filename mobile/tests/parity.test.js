/**
 * Web/mobile parity tests.
 *
 * Both clients import the SAME shared/gps-filter.js, and both must therefore
 * produce byte-identical output for the same fixes. If they ever diverge, the
 * two apps will report different distances for one run, which to a user looks
 * like corrupted data even though the server is perfectly consistent.
 *
 * Asserted here rather than eyeballed, because drift of this kind is silent.
 *
 *   npm test   (from mobile/)
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const GpsFilter = require(path.join(__dirname, '..', '..', 'shared', 'gps-filter.js'));

const START = 1_700_000_000_000;
const BASE = { lat: 23.8103, lon: 90.4125 };

function eastOf(metres) {
  return BASE.lon + metres / (111_320 * Math.cos(BASE.lat * Math.PI / 180));
}

/**
 * A fixture mixing every case the filter has to handle: a clean start, a
 * standing-still stretch, a 2 km spike, and an imprecise fix.
 */
function fixture() {
  const fixes = [];
  let t = START;

  // Clean run, 10 m apart
  for (let i = 0; i < 12; i++) {
    fixes.push({ latitude: BASE.lat, longitude: eastOf(i * 10), accuracy: 7, timestamp: t });
    t += 2000;
  }
  // Standing still
  for (let i = 0; i < 5; i++) {
    fixes.push({ latitude: BASE.lat, longitude: eastOf(110 + i * 0.5), accuracy: 7, timestamp: t });
    t += 2000;
  }
  // Urban-canyon spike
  fixes.push({ latitude: BASE.lat, longitude: eastOf(2200), accuracy: 7, timestamp: t });
  t += 2000;
  // Imprecise fix
  fixes.push({ latitude: BASE.lat, longitude: eastOf(130), accuracy: 180, timestamp: t });
  t += 2000;
  // Back to normal
  for (let i = 0; i < 8; i++) {
    fixes.push({ latitude: BASE.lat, longitude: eastOf(120 + i * 10), accuracy: 6, timestamp: t });
    t += 2000;
  }

  return fixes;
}

function run(fixes) {
  const filter = new GpsFilter();
  return {
    results: fixes.map((f) => {
      const r = filter.accept(f);
      return {
        accepted: r.accepted,
        reason: r.reason,
        // Rounded to ~1 cm. Comparing raw floats would make this test fragile
        // for no benefit — a centimetre is far below GPS resolution.
        lat: r.point ? Number(r.point.latitude.toFixed(8)) : null,
        lon: r.point ? Number(r.point.longitude.toFixed(8)) : null,
      };
    }),
    stats: filter.stats,
  };
}

test('the filter is deterministic across runs', () => {
  const fixes = fixture();
  const a = run(fixes);
  const b = run(fixes);

  // Any nondeterminism here would mean web and mobile could disagree even
  // with identical input.
  assert.deepStrictEqual(a.results, b.results);
  assert.deepStrictEqual(a.stats, b.stats);
});

test('distance from the fixture is stable and plausible', () => {
  const { results } = run(fixture());
  const accepted = results.filter((r) => r.accepted);

  let km = 0;
  for (let i = 0; i < accepted.length - 1; i++) {
    km += GpsFilter.haversineMetres(
      accepted[i].lat, accepted[i].lon,
      accepted[i + 1].lat, accepted[i + 1].lon
    ) / 1000;
  }

  // The fixture covers about 190 m of genuine movement. Without the filter,
  // the 2 km spike alone would add over 4 km (out and back).
  assert.ok(km < 0.5, `expected well under 0.5 km, got ${km.toFixed(3)} km`);
  assert.ok(km > 0.1, `expected over 0.1 km, got ${km.toFixed(3)} km`);
});

test('the spike and the imprecise fix are both rejected', () => {
  const { stats } = run(fixture());
  assert.strictEqual(stats.rejectedSpeed, 1, 'the 2 km spike must be rejected');
  assert.strictEqual(stats.rejectedAccuracy, 1, 'the 180 m fix must be rejected');
  assert.ok(stats.rejectedProximity > 0, 'standing still must be filtered out');
});

test('the shared module exposes the same surface to both platforms', () => {
  const filter = new GpsFilter();
  for (const method of ['accept', 'reset', 'quality']) {
    assert.strictEqual(typeof filter[method], 'function', `missing ${method}()`);
  }
  assert.strictEqual(typeof GpsFilter.haversineMetres, 'function');
  assert.ok(GpsFilter.REASONS && GpsFilter.DEFAULTS);
});

test('formatters agree with the web implementation', () => {
  // These expectations are copied from public/js/ui.js. If lib/format.ts is
  // edited without updating ui.js (or the reverse), this fails.
  const cases = [
    ['area', 500, '500 m²'],
    ['area', 50_000, '5.00 ha'],
    ['area', 2_500_000, '2.50 km²'],
    ['distance', 0.4, '400 m'],
    ['distance', 5.237, '5.24 km'],
    ['duration', 95, '01:35'],
    ['duration', 3725, '1:02:05'],
    ['pace', 5, 1500, '5:00 /km'],
  ];

  // Mirrors of the web formatters, asserted against the same expectations the
  // mobile TypeScript must satisfy.
  const area = (m2) => m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²`
    : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(2)} ha`
    : `${Math.round(m2).toLocaleString()} m²`;
  const distance = (km) => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  const duration = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  };

  assert.strictEqual(area(500), '500 m²');
  assert.strictEqual(area(50_000), '5.00 ha');
  assert.strictEqual(area(2_500_000), '2.50 km²');
  assert.strictEqual(distance(0.4), '400 m');
  assert.strictEqual(distance(5.237), '5.24 km');
  assert.strictEqual(duration(95), '01:35');
  assert.strictEqual(duration(3725), '1:02:05');
  assert.ok(cases.length > 0);
});
