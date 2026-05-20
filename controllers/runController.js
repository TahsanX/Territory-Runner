const { transaction } = require('../config/database');
const RunningSession = require('../models/RunningSession');
const RouteCoordinate = require('../models/RouteCoordinate');
const UserStatistics = require('../models/UserStatistics');
const DailyActivity = require('../models/DailyActivity');
const Territory = require('../models/Territory');
const Profile = require('../models/Profile');
const geoUtils = require('../utils/geoUtils');
const { waitUntil } = require('@vercel/functions');
const { reverseGeocode } = require('../utils/geocoder');
const logger = require('../utils/logger');

/** YYYY-MM-DD in the runner's own timezone, from the offset their browser reports. */
function localDateFrom(tzOffsetMinutes) {
  const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  // getTimezoneOffset() is positive west of UTC, so subtract to shift into local time.
  return new Date(Date.now() - offset * 60_000).toISOString().slice(0, 10);
}

exports.startSession = async (req, res, next) => {
  try {
    const tzOffsetMinutes = Number(req.body?.tzOffsetMinutes);
    const session = await RunningSession.create(req.user.id, {
      localDate: localDateFrom(tzOffsetMinutes),
      tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : null,
    });

    logger.info({ sessionId: session.id, userId: req.user.id }, 'Run started');

    res.status(201).json({
      sessionId: Number(session.id),
      startTime: session.start_time,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Accept a BATCH of coordinates.
 *
 * The old endpoint took one coordinate per request and did a findById, an
 * insert and a synchronous console.log for each — roughly 1,800 requests and
 * 3,600 queries for a 30-minute run. This takes up to 500 fixes per request,
 * verifies ownership once, and inserts them in a single statement.
 */
exports.addCoordinates = async (req, res, next) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const points = Array.isArray(req.body?.points) ? req.body.points : null;

    if (!points || points.length === 0) {
      return res.status(400).json({ message: 'points array is required.' });
    }
    if (points.length > 500) {
      return res.status(413).json({ message: 'Batch too large; send at most 500 points.' });
    }

    // Ownership check, once for the whole batch. Previously absent entirely,
    // which let any signed-in user write into another user's session.
    const session = await RunningSession.findOwnedById(sessionId, req.user.id);
    if (!session) return res.status(404).json({ message: 'Session not found.' });
    if (session.end_time) {
      return res.status(409).json({ message: 'This run has already finished.' });
    }

    const clean = [];
    for (const p of points) {
      const lat = Number(p.latitude);
      const lon = Number(p.longitude);
      const seq = Number(p.seq);
      if (!Number.isInteger(seq) || seq < 0) continue;
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
      clean.push({
        seq,
        latitude: lat,
        longitude: lon,
        accuracy: Number.isFinite(Number(p.accuracy)) ? Number(p.accuracy) : null,
        isPauseMarker: Boolean(p.isPauseMarker),
        recordedAt: p.recordedAt,
      });
    }

    if (clean.length === 0) {
      return res.status(400).json({ message: 'No valid coordinates in batch.' });
    }

    const inserted = await RouteCoordinate.insertBatch(sessionId, clean);

    res.json({
      received: clean.length,
      inserted,            // < received means duplicates were absorbed
      skipped: points.length - clean.length,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Record a pause.
 *
 * Previously this was a pure no-op that still cost a database round trip, and
 * the pause was represented by writing a fake [999, 999] coordinate into the
 * track which then had to be filtered out in four separate places. Now it is a
 * real marker row, so moving time can exclude the paused gap.
 */
exports.pauseSession = async (req, res, next) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const session = await RunningSession.findOwnedById(sessionId, req.user.id);
    if (!session) return res.status(404).json({ message: 'Session not found.' });

    const seq = Number(req.body?.seq);
    if (Number.isInteger(seq) && seq >= 0) {
      const lat = Number(req.body?.latitude);
      const lon = Number(req.body?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        await RouteCoordinate.insertBatch(sessionId, [{
          seq, latitude: lat, longitude: lon, isPauseMarker: true,
        }]);
      }
    }

    res.json({ paused: true });
  } catch (err) {
    next(err);
  }
};

/**
 * Finish a run: compute stats, capture the territory, take overlapping ground
 * from its current owners, and update every aggregate — all in ONE transaction.
 *
 * The old version ran the overlap handler fire-and-forget behind a swallowed
 * try/catch after the session had already been committed, so a failure left
 * the new territory's area counted while the victims kept theirs too.
 */
exports.finishSession = async (req, res, next) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const userId = req.user.id;

    const session = await RunningSession.findOwnedById(sessionId, userId);
    if (!session) return res.status(404).json({ message: 'Session not found.' });
    if (session.end_time) {
      return res.status(409).json({ message: 'This run has already finished.' });
    }

    // Flush any trailing client buffer handed over with the finish call, so a
    // run that ends the moment a batch was due does not lose its last points.
    if (Array.isArray(req.body?.points) && req.body.points.length) {
      const trailing = req.body.points
        .filter((p) => Number.isInteger(Number(p.seq)) &&
                       Number.isFinite(Number(p.latitude)) &&
                       Number.isFinite(Number(p.longitude)))
        .map((p) => ({
          seq: Number(p.seq),
          latitude: Number(p.latitude),
          longitude: Number(p.longitude),
          accuracy: Number.isFinite(Number(p.accuracy)) ? Number(p.accuracy) : null,
          isPauseMarker: Boolean(p.isPauseMarker),
          recordedAt: p.recordedAt,
        }));
      if (trailing.length) await RouteCoordinate.insertBatch(sessionId, trailing);
    }

    const rows = await RouteCoordinate.findBySession(sessionId);
    if (rows.length === 0) {
      return res.status(400).json({ message: 'No coordinates were recorded for this run.' });
    }

    const points = rows.map((r) => ({
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      isPauseMarker: r.is_pause_marker,
      recordedAt: r.recorded_at,
    }));
    const track = points.filter((p) => !p.isPauseMarker);

    const weightKg = await Profile.getWeightKg(userId);
    const stats = geoUtils.calculateRunningStats(points, { weightKg });

    // Fall back to wall-clock if timestamps were unusable, but never let the
    // reported duration exceed real elapsed time.
    const elapsed = Math.max(0, Math.floor((Date.now() - new Date(session.start_time)) / 1000));
    const timeSeconds = stats.time > 0 ? Math.min(stats.time, elapsed) : elapsed;

    const closed = geoUtils.isClosedLoop(track.map((p) => [p.latitude, p.longitude]));
    const localDate = session.local_date
      ? new Date(session.local_date).toISOString().slice(0, 10)
      : localDateFrom(session.tz_offset_minutes);

    let capture = null;

    await transaction(async (client) => {
      if (closed && track.length >= 3) {
        // [lat, lon] pairs; capture_territory() flips them for PostGIS.
        const coords = track.map((p) => [p.latitude, p.longitude]);
        capture = await Territory.capture(client, {
          userId, sessionId, coords, localDate,
        });
      }

      await UserStatistics.addRun(client, userId, {
        distance: stats.distance,
        timeSeconds,
        calories: stats.calories,
      });

      await DailyActivity.recordRun(client, userId, localDate, {
        distanceKm: stats.distance,
        movingSeconds: timeSeconds,
        calories: stats.calories,
      });

      await client.query(
        `UPDATE running_sessions
            SET end_time = now(), is_closed_loop = $3,
                total_distance = $4, total_time = $5, estimated_calories = $6,
                local_date = COALESCE(local_date, $7::date)
          WHERE id = $1 AND user_id = $2`,
        [sessionId, userId, Boolean(capture), stats.distance, timeSeconds,
         stats.calories, localDate]
      );
    });

    logger.info({
      sessionId, userId, distance: stats.distance,
      captured: Boolean(capture), stolen: capture?.areaStolenM2 || 0,
    }, 'Run finished');

    // Respond immediately; the place name is cosmetic and must not add the
    // latency of a third-party geocoder to the finish request.
    res.json({
      message: 'Run finished.',
      stats: { ...stats, time: timeSeconds },
      isClosedLoop: closed,
      territoryCreated: Boolean(capture),
      territoryId: capture?.territoryId ?? null,
      territoryArea: capture?.areaM2 ?? 0,
      areaStolen: capture?.areaStolenM2 ?? 0,
      territoriesAffected: capture?.victims ?? 0,
    });

    // Fire-and-forget is correct here, unlike for the steal: a missing place
    // name costs nothing, so it must never fail or delay the run.
    // waitUntil keeps a serverless function alive until the lookup settles;
    // without it the instance freezes the moment the response is sent and the
    // name is never saved. Elsewhere it is a no-op and the promise just runs.
    const bounds = geoUtils.boundsOf(track);
    if (bounds) {
      waitUntil(
        reverseGeocode(bounds.centreLat, bounds.centreLon)
          .then((place) => place && RunningSession.setPlace(sessionId, place))
          .catch((err) => logger.debug({ err: err.message }, 'Place lookup failed'))
      );
    }
  } catch (err) {
    next(err);
  }
};

exports.getSession = async (req, res, next) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const session = await RunningSession.findOwnedById(sessionId, req.user.id);
    if (!session) return res.status(404).json({ message: 'Session not found.' });

    const coordinates = await RouteCoordinate.findBySession(sessionId);
    res.json({
      session,
      coordinates: coordinates.map((c) => ({
        seq: c.seq,
        latitude: Number(c.latitude),
        longitude: Number(c.longitude),
        isPauseMarker: c.is_pause_marker,
        recordedAt: c.recorded_at,
      })),
    });
  } catch (err) {
    next(err);
  }
};

/** Resume point for a client that reconnects mid-run. */
exports.getSessionState = async (req, res, next) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const session = await RunningSession.findOwnedById(sessionId, req.user.id);
    if (!session) return res.status(404).json({ message: 'Session not found.' });

    res.json({
      sessionId,
      startTime: session.start_time,
      finished: Boolean(session.end_time),
      maxSeq: await RouteCoordinate.maxSeq(sessionId),
    });
  } catch (err) {
    next(err);
  }
};

exports.getRunHistory = async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sessions = await RunningSession.history(req.user.id, limit, offset);

    res.json({
      sessions: sessions.map((s) => ({
        id: Number(s.id),
        startTime: s.start_time,
        endTime: s.end_time,
        isClosedLoop: s.is_closed_loop,
        totalDistance: Number(s.total_distance),
        totalTime: s.total_time,
        estimatedCalories: s.estimated_calories,
        placeName: s.place_name,
        placeLocality: s.place_locality,
        territoryId: s.territory_id ? Number(s.territory_id) : null,
        territoryArea: s.territory_area ? Number(s.territory_area) : 0,
        createdAt: s.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
};
