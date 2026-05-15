/**
 * GPS fix filter.
 *
 * The previous build never read `position.coords.accuracy` at all, so every
 * fix the browser emitted — including the 1-2 km spikes you get between tall
 * buildings — was drawn on the map, added to the distance total, and POSTed to
 * the server. That, not the tile provider, was the real cause of the map being
 * inaccurate.
 *
 * Deliberately dependency-free UMD so the Phase 2 React Native app can import
 * this exact file. The two platforms must agree about what counts as a valid
 * fix, or web and mobile will disagree about the same run's distance.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GpsFilter = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    // Reject fixes less precise than this. 25 m is permissive enough for a
    // phone under tree cover but rejects the worst cell-tower fallbacks.
    maxAccuracyM: 25,
    // 7 m/s is roughly a 2:23/km pace — beyond any runner, so an implied speed
    // above it means the position jumped, not that the person moved.
    maxSpeedMps: 7,
    // Below this, we assume the runner is stationary and the apparent movement
    // is drift. Without it, standing at a traffic light accumulates distance.
    minDistanceM: 5,
    // The first fixes after a cold start are the least reliable, because the
    // receiver has not yet acquired enough satellites.
    warmupDiscardCount: 3,
    // Exponential smoothing weight for the new fix. 1 disables smoothing.
    smoothingAlpha: 0.6,
    // Ignore an implausible timestamp gap when computing speed.
    maxTimeGapS: 120,
  };

  var REASONS = {
    ACCEPTED: 'accepted',
    WARMUP: 'warmup',
    INACCURATE: 'inaccurate',
    TOO_FAST: 'too_fast',
    TOO_CLOSE: 'too_close',
    INVALID: 'invalid',
  };

  function haversineMetres(lat1, lon1, lat2, lon2) {
    var R = 6371008.8; // IUGG mean Earth radius
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function GpsFilter(options) {
    if (!(this instanceof GpsFilter)) return new GpsFilter(options);
    this.opts = Object.assign({}, DEFAULTS, options || {});
    this.reset();
  }

  GpsFilter.prototype.reset = function () {
    this.last = null;      // smoothed, what the caller draws
    this.lastRaw = null;   // unsmoothed, what the gates measure against
    this.seen = 0;
    this.stats = {
      total: 0, accepted: 0,
      rejectedWarmup: 0, rejectedAccuracy: 0,
      rejectedSpeed: 0, rejectedProximity: 0, rejectedInvalid: 0,
    };
  };

  /**
   * Offer one fix to the filter.
   *
   * @param {{latitude:number, longitude:number, accuracy?:number, timestamp?:number}} fix
   * @returns {{accepted:boolean, reason:string, point?:object, accuracy?:number}}
   */
  GpsFilter.prototype.accept = function (fix) {
    this.stats.total++;

    var lat = fix.latitude;
    var lon = fix.longitude;
    var acc = typeof fix.accuracy === 'number' ? fix.accuracy : null;
    var ts = fix.timestamp || Date.now();

    if (!isFinite(lat) || !isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      this.stats.rejectedInvalid++;
      return { accepted: false, reason: REASONS.INVALID };
    }

    if (acc !== null && acc > this.opts.maxAccuracyM) {
      this.stats.rejectedAccuracy++;
      return { accepted: false, reason: REASONS.INACCURATE, accuracy: acc };
    }

    // Count warm-up only against fixes that were otherwise acceptable,
    // so a run does not start with three good fixes discarded because the
    // first three were simply inaccurate.
    this.seen++;
    if (this.seen <= this.opts.warmupDiscardCount) {
      this.stats.rejectedWarmup++;
      return { accepted: false, reason: REASONS.WARMUP };
    }

    if (this.last) {
      // Gate on raw-to-raw movement. The smoothed point lags the runner, so
      // measuring from it inflated speed and rejected ordinary running pace.
      var moved = haversineMetres(this.lastRaw.latitude, this.lastRaw.longitude, lat, lon);
      var dtS = (ts - this.lastRaw.timestamp) / 1000;

      if (dtS > 0 && dtS < this.opts.maxTimeGapS) {
        if (moved / dtS > this.opts.maxSpeedMps) {
          // The spike case. Rejecting it also means `last` stays put, so the
          // next good fix is measured from the real position rather than from
          // the spike.
          this.stats.rejectedSpeed++;
          return { accepted: false, reason: REASONS.TOO_FAST };
        }
      }

      if (moved < this.opts.minDistanceM) {
        this.stats.rejectedProximity++;
        return { accepted: false, reason: REASONS.TOO_CLOSE };
      }

      this.lastRaw = { latitude: lat, longitude: lon, timestamp: ts };

      // Pull the new fix toward the previous one to damp jitter. Applied after
      // the gates so a rejected spike never contaminates the smoothed track.
      var alpha = this.opts.smoothingAlpha;
      if (alpha < 1) {
        lat = alpha * lat + (1 - alpha) * this.last.latitude;
        lon = alpha * lon + (1 - alpha) * this.last.longitude;
      }
    }

    if (!this.lastRaw || !this.last) this.lastRaw = { latitude: lat, longitude: lon, timestamp: ts };
    var accepted = { latitude: lat, longitude: lon, accuracy: acc, timestamp: ts };
    this.last = accepted;
    this.stats.accepted++;

    return { accepted: true, reason: REASONS.ACCEPTED, point: accepted, accuracy: acc };
  };

  /** Coarse signal quality, for the live indicator on the run screen. */
  GpsFilter.prototype.quality = function (accuracy) {
    if (accuracy === null || accuracy === undefined) return 'unknown';
    if (accuracy <= 8) return 'excellent';
    if (accuracy <= 15) return 'good';
    if (accuracy <= this.opts.maxAccuracyM) return 'fair';
    return 'poor';
  };

  GpsFilter.REASONS = REASONS;
  GpsFilter.DEFAULTS = DEFAULTS;
  GpsFilter.haversineMetres = haversineMetres;

  return GpsFilter;
}));
