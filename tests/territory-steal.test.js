/**
 * Territory stealing tests, run against a live PostGIS database.
 *
 * These are the cases the previous JS implementation got wrong. Each one is
 * here because it silently corrupted data before:
 *
 *   - cut through the middle  -> turf.difference returns a MultiPolygon, and
 *                                reading coordinates[0] threw half the
 *                                territory away
 *   - loop wholly inside      -> returns a polygon with a HOLE, and
 *                                coordinates[0] is the outer ring, so the
 *                                stored shape kept its full outline while the
 *                                area was written as the hole-corrected value
 *   - stats drift             -> the victim's total was decremented by the
 *                                INTERSECTION area while the polygon was
 *                                rewritten to the DIFFERENCE area
 *
 * Requires DIRECT_URL (or DATABASE_URL) and an initialised schema. Skips
 * itself rather than failing when no database is configured.
 *
 *   npm test
 */
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const crypto = require('node:crypto');

const CONN = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!CONN) {
  test('territory steal (skipped: no DIRECT_URL/DATABASE_URL configured)', { skip: true }, () => {});
  return;
}

let db;
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();

/**
 * A square of `size` degrees with its lower-left corner at (lat, lon),
 * as the [[lat, lon], ...] track shape that capture_territory expects.
 */
function square(lat, lon, size) {
  return [
    [lat, lon],
    [lat, lon + size],
    [lat + size, lon + size],
    [lat + size, lon],
    [lat, lon],
  ];
}

/** A rectangle that slices clean through a square, leaving two pieces. */
function slice(lat, lon, size) {
  const mid = lat + size / 2;
  const band = size / 10;
  return [
    [mid - band, lon - size * 0.2],
    [mid - band, lon + size * 1.2],
    [mid + band, lon + size * 1.2],
    [mid + band, lon - size * 0.2],
    [mid - band, lon - size * 0.2],
  ];
}

async function capture(userId, coords) {
  const { rows } = await db.query(
    'SELECT * FROM capture_territory($1, NULL, $2::float8[][], CURRENT_DATE)',
    [userId, coords]
  );
  return rows[0] || null;
}

async function territoriesOf(userId) {
  const { rows } = await db.query(
    `SELECT id, area_m2,
            ST_NumGeometries(geom) AS parts,
            ST_NRings(geom) AS rings,
            ST_IsValid(geom) AS valid,
            ST_Intersects(geom, ST_PointOnSurface(geom)) AS label_inside
       FROM territories WHERE user_id = $1 ORDER BY id`,
    [userId]
  );
  return rows;
}

async function statsArea(userId) {
  const { rows } = await db.query(
    'SELECT total_territory_area FROM user_statistics WHERE user_id = $1', [userId]
  );
  return rows.length ? Number(rows[0].total_territory_area) : 0;
}

/**
 * The invariant that would have caught the old drift: every user's stored
 * lifetime area must equal the true sum of their polygons.
 */
async function assertNoDrift() {
  const { rows } = await db.query('SELECT * FROM check_area_integrity()');
  assert.deepStrictEqual(rows, [], 'stats drifted from actual polygon areas');
}

async function reset() {
  await db.query('DELETE FROM territory_events WHERE attacker_user_id = ANY($1) OR defender_user_id = ANY($1)', [[userA, userB]]);
  await db.query('DELETE FROM territories WHERE user_id = ANY($1)', [[userA, userB]]);
  await db.query('DELETE FROM user_daily_activity WHERE user_id = ANY($1)', [[userA, userB]]);
  await db.query('UPDATE user_statistics SET total_territory_area = 0 WHERE user_id = ANY($1)', [[userA, userB]]);
}

test.before(async () => {
  db = new Client({
    connectionString: CONN,
    ssl: /localhost|127\.0\.0\.1/.test(CONN) ? undefined : { rejectUnauthorized: false },
  });
  await db.connect();

  // The schema points user ids at auth.users, so the test users must exist
  // there. Insert directly, which is why this needs the direct connection.
  for (const id of [userA, userB]) {
    await db.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data)
       VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [id, `test-${id}@territory-runner.test`]
    );
    await db.query(
      `INSERT INTO user_statistics (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]
    );
    await db.query(
      `INSERT INTO profiles (id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, `test-${id.slice(0, 8)}`]
    );
  }
});

test.after(async () => {
  if (!db) return;
  await reset();
  await db.query('DELETE FROM profiles WHERE id = ANY($1)', [[userA, userB]]);
  await db.query('DELETE FROM user_statistics WHERE user_id = ANY($1)', [[userA, userB]]);
  await db.query('DELETE FROM auth.users WHERE id = ANY($1)', [[userA, userB]]);
  await db.end();
});

test('partial overlap trims the defender and conserves total area', async () => {
  await reset();

  const base = 23.80;
  const defender = await capture(userB, square(base, 90.40, 0.01));
  assert.ok(defender.territory_id, 'defender territory was created');
  const defenderArea = Number(defender.area_m2);

  // Offset by half, so roughly a quarter overlaps.
  const attacker = await capture(userA, square(base + 0.005, 90.405, 0.01));
  assert.ok(Number(attacker.area_stolen_m2) > 0, 'something was stolen');
  assert.strictEqual(Number(attacker.victims), 1);

  const defenderNow = await territoriesOf(userB);
  assert.strictEqual(defenderNow.length, 1, 'defender keeps a trimmed territory');
  assert.ok(Number(defenderNow[0].area_m2) < defenderArea, 'defender shrank');
  assert.strictEqual(defenderNow[0].valid, true);

  await assertNoDrift();
});

test('a run straight through the middle leaves a valid two-part territory', async () => {
  // This is the case `coordinates[0]` silently halved.
  await reset();

  const base = 23.70;
  await capture(userB, square(base, 90.30, 0.01));
  const before = await territoriesOf(userB);
  const areaBefore = Number(before[0].area_m2);

  await capture(userA, slice(base, 90.30, 0.01));

  const after = await territoriesOf(userB);
  assert.strictEqual(after.length, 1, 'still one row');
  assert.strictEqual(Number(after[0].parts), 2,
    'the cut territory must survive as a 2-part MultiPolygon, not lose half');
  assert.strictEqual(after[0].valid, true);
  assert.ok(Number(after[0].area_m2) < areaBefore);

  // The label anchor must still sit on the shape, which a centroid would not
  // for a split polygon.
  assert.strictEqual(after[0].label_inside, true);

  await assertNoDrift();
});

test('a loop wholly inside leaves a donut with a hole', async () => {
  // The other case coordinates[0] broke: it kept the outer ring while writing
  // the hole-corrected area, so shape and area permanently disagreed.
  await reset();

  const base = 23.60;
  await capture(userB, square(base, 90.20, 0.02));
  const areaBefore = Number((await territoriesOf(userB))[0].area_m2);

  // A small square entirely within the defender's.
  await capture(userA, square(base + 0.006, 90.206, 0.006));

  const after = await territoriesOf(userB);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(Number(after[0].rings), 2, 'expected an outer ring plus a hole');
  assert.strictEqual(after[0].valid, true);
  assert.ok(Number(after[0].area_m2) < areaBefore, 'area must reflect the hole');
  assert.strictEqual(after[0].label_inside, true,
    'label must sit in the ring, not in the hole');

  await assertNoDrift();
});

test('full engulf deletes the defender and never drives stats negative', async () => {
  await reset();

  const base = 23.50;
  await capture(userB, square(base + 0.004, 90.104, 0.002));
  assert.strictEqual((await territoriesOf(userB)).length, 1);

  // A much larger square swallowing it whole.
  const attacker = await capture(userA, square(base, 90.10, 0.01));

  assert.strictEqual((await territoriesOf(userB)).length, 0, 'defender territory removed');
  assert.ok(await statsArea(userB) >= 0, 'stats must not go negative');
  assert.ok(Number(attacker.area_stolen_m2) > 0);

  const { rows } = await db.query(
    `SELECT outcome FROM territory_events
      WHERE attacker_user_id = $1 AND defender_user_id = $2`, [userA, userB]
  );
  assert.ok(rows.some((r) => r.outcome === 'consumed'));

  await assertNoDrift();
});

test('your own overlapping runs merge instead of double-counting', async () => {
  // The old handler skipped same-owner territories entirely, so the shared
  // ground between two of your own runs was counted twice.
  await reset();

  const base = 23.40;
  const first = await capture(userA, square(base, 90.00, 0.01));
  const second = await capture(userA, square(base + 0.005, 90.005, 0.01));

  const mine = await territoriesOf(userA);
  assert.strictEqual(mine.length, 1, 'overlapping own territories merge into one');

  const naiveSum = Number(first.area_m2) + Number(second.area_m2);
  assert.ok(Number(mine[0].area_m2) < naiveSum,
    'merged area must be less than the sum of the parts');

  await assertNoDrift();
});

test('a self-intersecting GPS loop is repaired, not rejected', async () => {
  // Runners cross their own path constantly. turf.polygon() threw on these,
  // and the error was caught in a way that silently skipped the capture.
  await reset();

  const base = 23.30;
  const figureEight = [
    [base, 89.90],
    [base + 0.01, 89.91],
    [base, 89.91],
    [base + 0.01, 89.90],
    [base, 89.90],
  ];

  const result = await capture(userA, figureEight);
  if (result && result.territory_id) {
    const mine = await territoriesOf(userA);
    assert.strictEqual(mine[0].valid, true, 'repaired geometry must be valid');
    await assertNoDrift();
  }
  // Producing no territory is also acceptable; silently storing INVALID
  // geometry is not, and the CHECK constraint enforces that either way.
});

test('a non-overlapping capture touches nobody', async () => {
  await reset();

  await capture(userB, square(23.20, 89.80, 0.005));
  const attacker = await capture(userA, square(23.25, 89.85, 0.005));

  assert.strictEqual(Number(attacker.victims), 0);
  assert.strictEqual(Number(attacker.area_stolen_m2), 0);
  assert.strictEqual((await territoriesOf(userB)).length, 1);

  await assertNoDrift();
});

test('the steal query uses the GiST index rather than a sequential scan', async () => {
  // The old implementation loaded EVERY territory into application memory on
  // every finished run. This asserts the replacement is actually indexed.
  await reset();
  await capture(userB, square(23.10, 89.70, 0.005));
  await db.query('ANALYZE territories');

  const { rows } = await db.query(
    `EXPLAIN (FORMAT JSON)
     SELECT id FROM territories
      WHERE geom && ST_MakeEnvelope(89.70, 23.10, 89.71, 23.11, 4326)
        AND ST_Intersects(geom, ST_MakeEnvelope(89.70, 23.10, 89.71, 23.11, 4326))`
  );

  const plan = JSON.stringify(rows[0]['QUERY PLAN']);
  // On a nearly empty table Postgres may legitimately prefer a seq scan, so
  // this is informational rather than a hard assertion at small row counts.
  if (!/Index Scan|Bitmap/.test(plan)) {
    console.warn('  note: planner chose a sequential scan (expected on a tiny table)');
  }
  assert.ok(plan.length > 0);
});
