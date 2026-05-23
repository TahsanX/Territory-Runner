const { query } = require('../config/database');
const DailyActivity = require('../models/DailyActivity');
const UserStatistics = require('../models/UserStatistics');

/**
 * Streak calendar and monthly/yearly summaries.
 *
 * Everything reads from user_daily_activity, which is written once per
 * finished run, so these are indexed range scans rather than aggregates over
 * raw sessions on every page view.
 *
 * All dates are the runner's LOCAL dates. A streak computed in UTC breaks for
 * anyone running late at night outside UTC — a 1am run in UTC+6 belongs to the
 * previous UTC day but is unambiguously today to the person who ran it.
 */

function monthRange(year, month) {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

function yearRange(year) {
  return [`${year}-01-01`, `${year}-12-31`];
}

/** Map a day's distance onto a 0-4 intensity level using the user's own quantiles. */
function intensityFor(distanceKm, t) {
  if (!distanceKm || distanceKm <= 0) return 0;
  if (distanceKm <= t.q1) return 1;
  if (distanceKm <= t.q2) return 2;
  if (distanceKm <= t.q3) return 3;
  return 4;
}

/**
 * GET /api/stats/calendar?year=&month=
 *
 * Returns one entry per day of the month with an intensity level: a longer run
 * that day gives a deeper, bolder cell; a short run gives a light, thin one;
 * a rest day is empty.
 */
exports.getCalendar = async (req, res, next) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || now.getUTCMonth() + 1;

    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      return res.status(400).json({ message: 'Invalid year or month.' });
    }

    const [from, to] = monthRange(year, month);
    const tzOffset = Number(req.query.tzOffset);
    const today = new Date(
      Date.now() - (Number.isFinite(tzOffset) ? tzOffset : 0) * 60_000
    ).toISOString().slice(0, 10);

    const [activity, thresholds, streak, longestThisMonth] = await Promise.all([
      DailyActivity.forRange(req.user.id, from, to),
      DailyActivity.intensityThresholds(req.user.id),
      DailyActivity.streaks(req.user.id, today),
      DailyActivity.longestStreakInRange(req.user.id, from, to),
    ]);

    const byDate = new Map(activity.map((a) => [a.date, a]));
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const a = byDate.get(date);
      days.push({
        date,
        day: d,
        // Monday-first, matching the calendar header
        weekday: (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7,
        runs: a?.runs || 0,
        distanceKm: a?.distanceKm || 0,
        calories: a?.calories || 0,
        areaGainedM2: a?.areaGainedM2 || 0,
        areaLostM2: a?.areaLostM2 || 0,
        intensity: intensityFor(a?.distanceKm, thresholds),
        isToday: date === today,
        isFuture: date > today,
      });
    }

    res.json({
      year, month, days, thresholds,
      streak: { ...streak, longestThisMonth },
      monthTotals: await DailyActivity.summaryTotals(req.user.id, from, to),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/stats/summary?period=month|year&year=&month=
 *
 * Covers every metric requested: most-visited places, streak days, calories,
 * new area captured, area lost, leaderboard position in both categories, and
 * the longest streak within the period.
 */
exports.getSummary = async (req, res, next) => {
  try {
    const now = new Date();
    const period = req.query.period === 'year' ? 'year' : 'month';
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || now.getUTCMonth() + 1;

    if (year < 2000 || year > 2100 || month < 1 || month > 12) {
      return res.status(400).json({ message: 'Invalid year or month.' });
    }

    const [from, to] = period === 'year' ? yearRange(year) : monthRange(year, month);
    const userId = req.user.id;
    const tzOffset = Number(req.query.tzOffset);
    const today = new Date(
      Date.now() - (Number.isFinite(tzOffset) ? tzOffset : 0) * 60_000
    ).toISOString().slice(0, 10);

    const [
      totals, longestStreak, streak, areaRank, distanceRank,
      places, best, daily, lostDetail,
    ] = await Promise.all([
      DailyActivity.summaryTotals(userId, from, to),
      DailyActivity.longestStreakInRange(userId, from, to),
      DailyActivity.streaks(userId, today),
      UserStatistics.rankFor(userId, 'area'),
      UserStatistics.rankFor(userId, 'distance'),

      // Most-visited places. A GROUP BY over the place name cached on each
      // session at finish time — no geocoding happens in this request.
      query(
        `SELECT place_locality AS locality,
                COUNT(*)::int AS visits,
                SUM(total_distance) AS distance_km
           FROM running_sessions
          WHERE user_id = $1
            AND local_date BETWEEN $2 AND $3
            AND place_locality IS NOT NULL
          GROUP BY place_locality
          ORDER BY visits DESC, distance_km DESC
          LIMIT 8`,
        [userId, from, to]
      ),

      query(
        `SELECT id, total_distance, total_time, estimated_calories,
                place_locality, local_date
           FROM running_sessions
          WHERE user_id = $1 AND local_date BETWEEN $2 AND $3
            AND end_time IS NOT NULL
          ORDER BY total_distance DESC
          LIMIT 1`,
        [userId, from, to]
      ),

      // Per-period series for the chart: days for a month, months for a year.
      period === 'year'
        ? query(
            `SELECT TO_CHAR(local_date, 'YYYY-MM') AS bucket,
                    SUM(distance_km) AS distance_km,
                    SUM(area_gained_m2) AS area_gained_m2,
                    SUM(area_lost_m2) AS area_lost_m2,
                    SUM(runs)::int AS runs
               FROM user_daily_activity
              WHERE user_id = $1 AND local_date BETWEEN $2 AND $3
              GROUP BY bucket ORDER BY bucket`,
            [userId, from, to]
          )
        : query(
            `SELECT TO_CHAR(local_date, 'YYYY-MM-DD') AS bucket,
                    distance_km, area_gained_m2, area_lost_m2, runs
               FROM user_daily_activity
              WHERE user_id = $1 AND local_date BETWEEN $2 AND $3
              ORDER BY local_date`,
            [userId, from, to]
          ),

      // Who took ground from you, from the steal audit log.
      query(
        `SELECT COUNT(*)::int AS events,
                COALESCE(SUM(area_transferred_m2), 0) AS area,
                COUNT(DISTINCT attacker_user_id)::int AS rivals
           FROM territory_events
          WHERE defender_user_id = $1 AND local_date BETWEEN $2 AND $3`,
        [userId, from, to]
      ),
    ]);

    const stolenFromOthers = await query(
      `SELECT COUNT(*)::int AS events,
              COALESCE(SUM(area_transferred_m2), 0) AS area
         FROM territory_events
        WHERE attacker_user_id = $1 AND local_date BETWEEN $2 AND $3`,
      [userId, from, to]
    );

    const bestRun = best.rows[0];

    res.json({
      period, year, month: period === 'month' ? month : null, from, to,

      totals: {
        runs: totals.runs,
        activeDays: totals.activeDays,
        distanceKm: Number(totals.distanceKm.toFixed(2)),
        movingSeconds: totals.movingSeconds,
        calories: totals.calories,
        areaGainedM2: Math.round(totals.areaGainedM2),
        areaLostM2: Math.round(totals.areaLostM2),
        netAreaM2: Math.round(totals.areaGainedM2 - totals.areaLostM2),
      },

      streak: {
        longestInPeriod: longestStreak,
        current: streak.current,
        longestAllTime: streak.longest,
      },

      ranks: { area: areaRank, distance: distanceRank },

      places: places.rows.map((p) => ({
        locality: p.locality,
        visits: p.visits,
        distanceKm: Number(Number(p.distance_km).toFixed(2)),
      })),

      territoryBattles: {
        lost: {
          events: lostDetail.rows[0].events,
          areaM2: Math.round(Number(lostDetail.rows[0].area)),
          rivals: lostDetail.rows[0].rivals,
        },
        won: {
          events: stolenFromOthers.rows[0].events,
          areaM2: Math.round(Number(stolenFromOthers.rows[0].area)),
        },
      },

      bestRun: bestRun
        ? {
            id: Number(bestRun.id),
            distanceKm: Number(bestRun.total_distance),
            timeSeconds: bestRun.total_time,
            calories: bestRun.estimated_calories,
            locality: bestRun.place_locality,
            date: bestRun.local_date,
          }
        : null,

      series: daily.rows.map((r) => ({
        bucket: r.bucket,
        distanceKm: Number(r.distance_km),
        areaGainedM2: Number(r.area_gained_m2),
        areaLostM2: Number(r.area_lost_m2),
        runs: r.runs,
      })),
    });
  } catch (err) {
    next(err);
  }
};
