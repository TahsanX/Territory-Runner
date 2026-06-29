/**
 * Dashboard: profile stats, streak calendar, territory map, recent runs.
 *
 * getToken() and logout() used to be redefined here (and in two other files);
 * both now live once in api.js. Section data is fetched in parallel rather
 * than sequentially, so one slow query doesn't delay the whole page.
 */
(function (window) {
  'use strict';

  var api = window.TRApi;
  var ui = window.TRUi;
  var fmt = ui.fmt;

  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var node = $(id);
    if (node) node.textContent = value;
  }

  function renderProfile(data) {
    var nav = $('nav-username');
    if (nav) {
      nav.textContent = data.user.username;
      nav.classList.remove('hidden');
    }
    setText('greeting-name', data.user.username);

    setText('stat-total-distance', data.stats.totalDistance.toFixed(1));
    setText('stat-total-area', fmt.area(data.stats.totalTerritoryArea));
    setText('stat-total-calories', fmt.number(data.stats.totalCalories));
    setText('stat-total-runs', fmt.number(data.stats.totalRunningSessions));

    if (data.ranks.area) {
      setText('rank-area', fmt.ordinal(data.ranks.area.rank) + ' of ' + data.ranks.area.total);
    }
    if (data.ranks.distance) {
      setText('rank-distance', fmt.ordinal(data.ranks.distance.rank) + ' of ' + data.ranks.distance.total);
    }
  }

  function renderHistory(sessions) {
    var box = $('history-list');
    if (!box) return;

    if (!sessions.length) {
      box.innerHTML =
        '<div class="empty-state">' +
          '<p class="empty-title">No runs yet</p>' +
          '<p class="empty-text">Start a run and complete a loop back to where you began to claim your first territory.</p>' +
          '<a href="/run" class="btn-primary mt-2">Start running</a>' +
        '</div>';
      return;
    }

    box.innerHTML = '<ul class="divide-rows">' + sessions.map(function (s) {
      var captured = s.territoryId
        ? '<span class="badge badge-own">+' + fmt.area(s.territoryArea) + '</span>'
        : '<span class="badge badge-neutral">No capture</span>';

      return '<li class="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">' +
        '<div class="min-w-0">' +
          '<p class="truncate text-sm font-medium text-ink-800">' +
            fmt.distance(s.totalDistance) + ' · ' + fmt.duration(s.totalTime) +
          '</p>' +
          '<p class="truncate text-xs text-ink-500">' +
            fmt.dateTime(s.endTime || s.createdAt) +
            (s.placeLocality ? ' · ' + ui.escapeHtml(s.placeLocality) : '') +
          '</p>' +
        '</div>' +
        '<div class="shrink-0 text-right">' + captured +
          '<p class="mt-1 numeric text-xs text-ink-400">' +
            fmt.pace(s.totalDistance, s.totalTime) + '</p>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function initMap() {
    var node = $('territory-map');
    if (!node) return null;

    var map = window.TRMap.createMap('territory-map', { zoom: 14 });
    var layer = new window.TRTerritoryLayer(map, {
      onRender: function () {
        var own = 0;
        layer.known.forEach(function (e) { if (e.data.isOwn) own++; });
        setText('territory-count', own);
      },
    });

    // Ask for the position straight away, in parallel with the territory fetch.
    // It used to be requested only after the fetch, never drew a marker, and
    // swallowed every error — so the map gave no sign of where the user was or
    // why it didn't know.
    var located = locateUser(map);

    // Centre on the user's own territory if they have any; otherwise on their
    // position; otherwise the shared default centre.
    // Street level (16) shows the user's neighbourhood with its roads named.
    Promise.all([layer.refresh(), located]).then(function (res) {
      if (layer.fitToOwn()) return;
      if (res[1]) map.setView(res[1], 16);
    });

    return layer;
  }

  /** Resolves to [lat, lng] once the "you are here" marker is drawn, or null. */
  function locateUser(map) {
    return new Promise(function (resolve) {
      // Browsers only expose geolocation on https:// or http://localhost.
      // Opening the app at http://192.168.x.x fails silently without this.
      if (!window.isSecureContext) {
        ui.toast('Location needs https:// or http://localhost — open the app at localhost to see your position.', 'error');
        return resolve(null);
      }
      if (!navigator.geolocation) return resolve(null);

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          var ll = [pos.coords.latitude, pos.coords.longitude];
          window.TRMap.accuracyCircle(ll, pos.coords.accuracy).addTo(map);
          L.marker(ll, {
            icon: window.TRMap.runnerIcon(),
            interactive: false,
            keyboard: false,
            zIndexOffset: 1000,
          }).addTo(map);
          // Next visit opens here immediately, before the new fix arrives.
          window.TRMap.rememberCentre(ll[0], ll[1]);
          resolve(ll);
        },
        function (err) {
          if (err.code === err.PERMISSION_DENIED) {
            ui.toast('Location is blocked. Allow it from the lock icon in the address bar to see where you are.', 'error');
          }
          // Unavailable / timeout: keep the fallback centre without nagging.
          resolve(null);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
      );
    });
  }

  document.addEventListener('DOMContentLoaded', async function () {
    initMap();

    var calendar = new window.TRCalendar('streak-calendar');

    // Parallel, not sequential: these are independent queries.
    var results = await Promise.allSettled([
      api.get('/api/auth/profile'),
      api.get('/api/run/history/all', { limit: 8 }),
      calendar.load(),
    ]);

    if (results[0].status === 'fulfilled') renderProfile(results[0].value);
    if (results[1].status === 'fulfilled') renderHistory(results[1].value.sessions);

    var failed = results.filter(function (r) { return r.status === 'rejected'; });
    if (failed.length === results.length) {
      ui.toast('Could not load your dashboard. Check your connection.', 'error');
    }

    window.TRLoader.dataReady();
    window.TRLoader.ready();
  });
}(window));
