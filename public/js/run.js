/**
 * Live run tracking.
 *
 * Three structural changes from the previous version:
 *
 *  1. Coordinates are BUFFERED and flushed in batches. The old code POSTed one
 *     request per GPS fix, so a 30-minute run was ~1,800 round trips, each one
 *     also awaited inside the watchPosition callback.
 *
 *  2. Every fix passes through the shared GPS filter. The old code never read
 *     position.coords.accuracy at all, so a 2 km urban-canyon spike was drawn,
 *     counted toward distance, and saved.
 *
 *  3. The route polyline is APPENDED to, not rebuilt. setLatLngs() on every
 *     fix re-rendered the whole growing path — O(n) per fix, O(n²) per run.
 *     The map also no longer re-centres on every fix, which used to force a
 *     tile re-render and made it impossible to pan away mid-run.
 */
(function (window) {
  'use strict';

  var api = window.TRApi;
  var ui = window.TRUi;
  var fmt = ui.fmt;

  // Flush whichever comes first. 20 points at ~1 fix/sec is a request every
  // 20 s; the 10 s ceiling keeps the server's view fresh during slow stretches
  // where few fixes pass the filter.
  var FLUSH_POINTS = 20;
  var FLUSH_MS = 10000;

  var state = {
    sessionId: null,
    running: false,
    paused: false,
    startedAt: null,
    pausedMs: 0,
    pauseStartedAt: null,
    seq: 0,
    buffer: [],
    accepted: [],       // filtered track, for distance and the polyline
    watchId: null,
    flushTimer: null,
    tickTimer: null,
    follow: true,
    lastFlushAt: 0,
    filter: null,
  };

  var map, routeLayer, marker, accuracyRing, territoryLayer, capturedLayer;

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  var el = {};
  function cacheDom() {
    ['run-map', 'btn-start', 'btn-pause', 'btn-finish', 'btn-follow',
     'stat-distance', 'stat-time', 'stat-pace', 'stat-calories',
     'gps-status', 'gps-detail', 'run-state', 'run-result', 'point-count'
    ].forEach(function (id) { el[id] = $(id); });
  }

  // -------------------------------------------------------------------------
  // Map
  // -------------------------------------------------------------------------
  function initMap() {
    map = window.TRMap.createMap('run-map', { zoom: 16 });
    routeLayer = window.TRMap.routeLine().addTo(map);
    capturedLayer = L.layerGroup().addTo(map);

    // Show existing territories so the runner can see what there is to take.
    territoryLayer = new window.TRTerritoryLayer(map);
    territoryLayer.refresh();

    // Any manual interaction turns off follow-me. Previously the map snapped
    // back to the runner on every fix, so panning was impossible.
    map.on('dragstart', function () { setFollow(false); });
  }

  function setFollow(on) {
    state.follow = on;
    if (el['btn-follow']) {
      el['btn-follow'].classList.toggle('btn-primary', !on);
      el['btn-follow'].classList.toggle('btn-secondary', on);
      el['btn-follow'].setAttribute('aria-pressed', String(on));
      el['btn-follow'].textContent = on ? 'Map is following you' : 'Re-centre on me';
    }
    if (on && marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
  }

  var hasCentred = false;
  var previewFilter = null;

  /** Moves the "you are here" marker to every raw fix, accepted or not. */
  function showPosition(position) {
    var latlng = [position.coords.latitude, position.coords.longitude];
    var acc = position.coords.accuracy;
    if (!marker) {
      marker = L.marker(latlng, {
        icon: window.TRMap.runnerIcon(), zIndexOffset: 1000, interactive: false, keyboard: false,
      }).addTo(map);
      accuracyRing = window.TRMap.accuracyCircle(latlng, acc).addTo(map);
    } else {
      marker.setLatLng(latlng);
      accuracyRing.setLatLng(latlng);
      accuracyRing.setRadius(Math.max(acc || 0, 3));
    }

    if (!hasCentred) {
      hasCentred = true;
      map.setView(latlng, 17);
    } else if (state.follow && !map.getBounds().pad(-0.3).contains(latlng)) {
      map.panTo(latlng, { animate: true, duration: 0.5 });
    }
    window.TRMap.rememberCentre(latlng[0], latlng[1]);
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------
  function elapsedSeconds() {
    if (!state.startedAt) return 0;
    var paused = state.pausedMs +
      (state.pauseStartedAt ? Date.now() - state.pauseStartedAt : 0);
    return Math.max(0, Math.floor((Date.now() - state.startedAt - paused) / 1000));
  }

  /**
   * Running total maintained incrementally.
   *
   * Recomputing the whole Haversine sum on every fix, as the old code did, is
   * O(n) per fix for a value that only ever grows by one segment.
   */
  var distanceKm = 0;
  function addSegment(prev, next) {
    if (!prev) return;
    distanceKm += window.GpsFilter.haversineMetres(
      prev.latitude, prev.longitude, next.latitude, next.longitude) / 1000;
  }

  function updateDisplay() {
    var secs = elapsedSeconds();
    if (el['stat-distance']) el['stat-distance'].textContent = distanceKm.toFixed(2);
    if (el['stat-time']) el['stat-time'].textContent = fmt.duration(secs);
    if (el['stat-pace']) el['stat-pace'].textContent = fmt.pace(distanceKm, secs);
    if (el['stat-calories']) {
      // Mirrors the server's formula; the authoritative figure comes back on finish.
      el['stat-calories'].textContent = Math.round(distanceKm * 70 * 0.63);
    }
    if (el['point-count']) el['point-count'].textContent = state.accepted.length;
  }

  function setGpsQuality(quality, accuracy, reason) {
    if (!el['gps-status']) return;
    var labels = {
      excellent: 'Strong signal', good: 'Good signal', fair: 'Weak signal',
      poor: 'Poor signal', unknown: 'Acquiring…',
    };
    el['gps-status'].className = 'gps-pill gps-' + quality;
    el['gps-status'].textContent = labels[quality] || 'Acquiring…';

    // Telling the runner WHY points are being dropped stops the app looking
    // broken when it is actually working correctly.
    if (el['gps-detail']) {
      var detail = accuracy ? '±' + Math.round(accuracy) + ' m' : '';
      if (reason === 'inaccurate') detail += ' · fix rejected, too imprecise';
      else if (reason === 'too_fast') detail += ' · jump rejected';
      else if (reason === 'warmup') detail = 'Letting GPS settle…';
      el['gps-detail'].textContent = detail;
    }
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------
  async function flush(force) {
    if (!state.sessionId || state.buffer.length === 0) return;
    if (!force && state.buffer.length < FLUSH_POINTS &&
        Date.now() - state.lastFlushAt < FLUSH_MS) return;

    var batch = state.buffer;
    state.buffer = [];
    state.lastFlushAt = Date.now();

    try {
      await api.post('/api/run/' + state.sessionId + '/coordinates', { points: batch });
    } catch (err) {
      // Put them back so nothing is lost; the seq unique constraint means a
      // later retry cannot duplicate anything that did land.
      state.buffer = batch.concat(state.buffer);
      if (err.offline) {
        setGpsQuality('unknown', null);
        if (el['gps-detail']) el['gps-detail'].textContent = 'Offline — ' + state.buffer.length + ' points queued';
      } else {
        console.warn('Coordinate upload failed:', err.message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tracking
  // -------------------------------------------------------------------------
  function onPosition(position) {
    showPosition(position);
    if (!state.running || state.paused) {
      if (!state.running) {
        if (!previewFilter) previewFilter = new window.GpsFilter();
        setGpsQuality(previewFilter.quality(position.coords.accuracy), position.coords.accuracy);
      }
      return;
    }

    var result = state.filter.accept({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp,
    });

    setGpsQuality(
      state.filter.quality(position.coords.accuracy),
      position.coords.accuracy,
      result.accepted ? null : result.reason
    );

    if (!result.accepted) return;

    var point = result.point;
    var prev = state.accepted[state.accepted.length - 1];

    addSegment(prev, point);
    state.accepted.push(point);

    // addLatLng appends; setLatLngs would redraw the entire path.
    routeLayer.addLatLng([point.latitude, point.longitude]);

    state.buffer.push({
      seq: state.seq++,
      latitude: point.latitude,
      longitude: point.longitude,
      accuracy: point.accuracy,
      recordedAt: new Date(point.timestamp).toISOString(),
    });

    flush(false);
    updateDisplay();
  }

  function onPositionError(err) {
    var messages = {
      1: 'Location permission denied. Enable it in your browser settings to record a run.',
      2: 'Location unavailable. Try moving somewhere with a clearer view of the sky.',
      3: 'Location request timed out.',
    };
    setGpsQuality('poor', null);
    if (err.code === 1) {
      ui.toast(messages[1], 'error', 9000);
      stopTracking();
      state.running = false;
      renderControls();
    } else if (err.code !== 3) {
      // Timeouts are routine with watchPosition and not worth a toast.
      ui.toast(messages[err.code] || 'Location error.', 'error');
    }
  }

  function startTracking() {
    if (state.watchId !== null) return true;
    if (!window.isSecureContext) {
      ui.toast('GPS needs https:// (or localhost). On a phone, open the deployed https site.', 'error', 9000);
      setGpsQuality('poor', null);
      return false;
    }
    if (!navigator.geolocation) {
      ui.toast('This browser does not support geolocation.', 'error');
      return false;
    }
    state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
    return true;
  }

  function stopTracking() {
    if (state.watchId !== null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    }
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.flushTimer) { clearInterval(state.flushTimer); state.flushTimer = null; }
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------
  function renderControls() {
    var idle = !state.running;
    if (el['btn-start']) el['btn-start'].hidden = !idle;
    if (el['btn-pause']) el['btn-pause'].hidden = idle;
    if (el['btn-finish']) el['btn-finish'].hidden = idle;
    if (el['btn-pause']) {
      el['btn-pause'].textContent = state.paused ? 'Resume' : 'Pause';
      el['btn-pause'].className = state.paused ? 'btn-primary btn-lg' : 'btn-warning btn-lg';
    }
    if (el['run-state']) {
      el['run-state'].textContent = idle ? 'Ready' : (state.paused ? 'Paused' : 'Recording');
      el['run-state'].className = 'badge ' +
        (idle ? 'badge-neutral' : (state.paused ? 'badge-rival' : 'badge-own'));
    }
  }

  async function start() {
    el['btn-start'].disabled = true;
    try {
      var res = await api.post('/api/run/start', { tzOffsetMinutes: api.tzOffset() });
      state.sessionId = res.sessionId;
      state.running = true;
      state.paused = false;
      state.startedAt = Date.now();
      state.pausedMs = 0;
      state.seq = 0;
      state.accepted = [];
      state.buffer = [];
      distanceKm = 0;
      state.filter = new window.GpsFilter();

      routeLayer.setLatLngs([]);
      capturedLayer.clearLayers();
      if (el['run-result']) el['run-result'].innerHTML = '';

      if (!startTracking()) throw new Error('Could not start location tracking');

      state.tickTimer = setInterval(updateDisplay, 1000);
      state.flushTimer = setInterval(function () { flush(false); }, FLUSH_MS);

      setFollow(true);
      renderControls();
      ui.toast('Run started. Complete a loop back to your start point to claim it.', 'info', 5000);
    } catch (err) {
      ui.toast(err.message || 'Could not start the run.', 'error');
    } finally {
      el['btn-start'].disabled = false;
    }
  }

  async function togglePause() {
    if (!state.running) return;

    if (state.paused) {
      state.pausedMs += Date.now() - state.pauseStartedAt;
      state.pauseStartedAt = null;
      state.paused = false;
      // A pause breaks the track; don't let the filter measure speed across
      // the gap and reject the first fix back as an impossible jump.
      state.filter.reset();
    } else {
      state.paused = true;
      state.pauseStartedAt = Date.now();

      // A real marker row, replacing the [999, 999] fake coordinate the old
      // build wrote into the track and then had to filter out in four places.
      var last = state.accepted[state.accepted.length - 1];
      try {
        await flush(true);
        await api.post('/api/run/' + state.sessionId + '/pause', last ? {
          seq: state.seq++, latitude: last.latitude, longitude: last.longitude,
        } : {});
      } catch (err) { /* the pause is still correct locally */ }
    }
    renderControls();
  }

  async function finish() {
    if (!state.running) return;
    if (state.accepted.length < 3) {
      ui.toast('Not enough GPS points recorded yet to save this run.', 'error');
      return;
    }

    el['btn-finish'].disabled = true;
    el['btn-finish'].textContent = 'Saving…';
    stopTracking();

    try {
      // Hand the trailing buffer over with the finish call so nothing is lost
      // if the run ends between flushes.
      var trailing = state.buffer;
      state.buffer = [];

      var res = await api.post('/api/run/' + state.sessionId + '/finish', { points: trailing });

      state.running = false;
      state.paused = false;
      renderControls();
      renderResult(res);
      territoryLayer.refresh();
    } catch (err) {
      ui.toast(err.message || 'Could not save the run.', 'error', 8000);
      el['btn-finish'].disabled = false;
      el['btn-finish'].textContent = 'Finish';
    }
  }

  function renderResult(res) {
    var box = el['run-result'];
    if (!box) return;

    var html = '<div class="card card-pad">';

    if (res.territoryCreated) {
      html += '<p class="mb-1 text-sm font-semibold text-own">Territory captured</p>' +
              '<p class="text-stat numeric text-ink-900">' + fmt.area(res.territoryArea) + '</p>';

      if (res.areaStolen > 0) {
        html += '<p class="mt-2 text-sm text-ink-600">' +
                'Took <strong>' + fmt.area(res.areaStolen) + '</strong> from ' +
                res.territoriesAffected +
                (res.territoriesAffected === 1 ? ' rival territory' : ' rival territories') +
                '</p>';
      }

      // Draw the captured polygon so the result is visible, not just numeric.
      var ring = state.accepted.map(function (p) { return [p.latitude, p.longitude]; });
      L.polygon(ring, window.TRMap.territoryStyle(true)).addTo(capturedLayer);
    } else {
      html += '<p class="mb-1 text-sm font-semibold text-ink-700">Run saved</p>' +
              '<p class="text-xs text-ink-500">' +
              (res.isClosedLoop
                ? 'The loop closed but the enclosed area was too small to claim.'
                : 'No territory this time — finish within 50 m of where you started to close the loop.') +
              '</p>';
    }

    html += '<dl class="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">' +
      statCell('Distance', fmt.distance(res.stats.distance)) +
      statCell('Time', fmt.duration(res.stats.time)) +
      statCell('Pace', fmt.pace(res.stats.distance, res.stats.time)) +
      statCell('Calories', fmt.number(res.stats.calories)) +
      '</dl>' +
      '<div class="mt-4 flex gap-2">' +
        '<a href="/" class="btn-primary">Back to dashboard</a>' +
        '<button type="button" class="btn-secondary" onclick="window.location.reload()">New run</button>' +
      '</div></div>';

    box.innerHTML = html;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ui.toast(res.territoryCreated ? 'Territory captured.' : 'Run saved.', 'success');
  }

  function statCell(label, value) {
    return '<div><dt class="stat-label">' + label + '</dt>' +
           '<dd class="numeric font-semibold text-ink-900">' + value + '</dd></div>';
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    cacheDom();
    initMap();
    renderControls();
    updateDisplay();
    setGpsQuality('unknown', null);
    setFollow(true);
    // Track from page load so the runner sees where they are before starting.
    startTracking();

    el['btn-start'].addEventListener('click', start);
    el['btn-pause'].addEventListener('click', togglePause);
    el['btn-finish'].addEventListener('click', finish);
    if (el['btn-follow']) {
      el['btn-follow'].addEventListener('click', function () { setFollow(!state.follow); });
    }

    window.TRLoader.dataReady();
    window.TRLoader.ready();
  });

  // Last-chance flush when the page goes away. A normal fetch would be killed
  // mid-flight; sendBeacon survives unload.
  window.addEventListener('pagehide', function () {
    if (state.sessionId && state.buffer.length) {
      api.beacon('/api/run/' + state.sessionId + '/coordinates', { points: state.buffer });
      state.buffer = [];
    }
  });

  // A browser suspends geolocation for a backgrounded tab, so the track has a
  // hole. Warn honestly rather than pretending it was recorded — background
  // tracking is a native capability and the reason for the Phase 2 app.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.running && !state.paused) {
      state.filter.reset();
      ui.toast('Welcome back — GPS pauses while the tab is hidden, so part of the route may be missing.',
               'info', 6000);
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
}(window));
