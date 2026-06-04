/**
 * Leaderboard with two tabs: territory area and total distance.
 * Both metrics are backed by their own DESC index.
 */
(function (window) {
  'use strict';

  var api = window.TRApi;
  var ui = window.TRUi;
  var fmt = ui.fmt;

  var metric = 'area';
  var myUsername = null;

  function $(id) { return document.getElementById(id); }

  /** Ranks 1-3 get a medal chip; the rest stay plain so the podium stands out. */
  function rankCell(rank) {
    var cls = rank <= 3 ? 'rank rank-' + rank : 'rank rank-plain';
    return '<span class="' + cls + '">' + rank + '</span>';
  }

  /** Initials avatar. Deterministic hue so a runner keeps the same colour. */
  function avatar(name) {
    var hue = 0;
    for (var i = 0; i < name.length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
    return '<span class="avatar" style="background:hsl(' + hue + ' 62% 94%);color:hsl(' + hue + ' 48% 32%)">' +
      ui.escapeHtml(name.slice(0, 2).toUpperCase()) + '</span>';
  }

  function renderTable(rows) {
    var body = $('leaderboard-body');
    if (!body) return;

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5">' +
        '<div class="empty-state">' +
          '<p class="empty-title">No ground claimed yet</p>' +
          '<p class="empty-text">Close a loop on your first run and you will take the top spot by default.</p>' +
          '<a href="/run" class="btn-primary mt-2">Start a run</a>' +
        '</div></td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (r) {
      var isMe = myUsername && r.username === myUsername;
      var primary = metric === 'area' ? fmt.area(r.total_territory_area)
                                      : fmt.distance(r.total_distance);
      var secondary = metric === 'area' ? fmt.distance(r.total_distance)
                                        : fmt.area(r.total_territory_area);

      return '<tr class="' + (isMe ? 'row-me' : '') + '">' +
        '<td class="w-14">' + rankCell(r.rank) + '</td>' +
        '<td>' +
          '<span class="flex items-center gap-2.5">' +
            avatar(r.username) +
            '<span class="font-medium text-ink-800">' + ui.escapeHtml(r.username) + '</span>' +
            (isMe ? '<span class="badge badge-own">You</span>' : '') +
          '</span>' +
        '</td>' +
        '<td class="numeric font-semibold text-ink-900">' + primary + '</td>' +
        '<td class="numeric text-ink-600">' + secondary + '</td>' +
        '<td class="numeric text-ink-500">' + fmt.number(r.total_running_sessions) + '</td>' +
      '</tr>';
    }).join('');

    var header = $('metric-header');
    if (header) header.textContent = metric === 'area' ? 'Territory' : 'Distance';
    var altHeader = $('metric-alt-header');
    if (altHeader) altHeader.textContent = metric === 'area' ? 'Distance' : 'Territory';
  }

  function renderRank(rank) {
    var box = $('your-rank');
    if (!box) return;
    if (!rank) { box.hidden = true; return; }

    var label = metric === 'area' ? 'territory held' : 'distance covered';
    var value = metric === 'area' ? fmt.area(rank.value) : fmt.distance(rank.value);
    // Percentile is more motivating than a bare rank once the field is large.
    var ahead = rank.total - rank.rank;

    box.hidden = false;
    box.innerHTML =
      '<div class="flex flex-wrap items-center justify-between gap-4">' +
        '<div>' +
          '<p class="stat-label">Your position</p>' +
          '<p class="text-stat-lg numeric text-accent-700">' + fmt.ordinal(rank.rank) + '</p>' +
          '<p class="mt-0.5 text-xs text-ink-500">of ' + rank.total +
            (rank.total === 1 ? ' runner' : ' runners') + '</p>' +
        '</div>' +
        '<div class="text-right">' +
          '<p class="stat-label justify-end">' + label + '</p>' +
          '<p class="text-stat numeric text-ink-900">' + value + '</p>' +
          (ahead > 0
            ? '<p class="mt-0.5 text-xs text-success">Ahead of ' + ahead +
              (ahead === 1 ? ' runner' : ' runners') + '</p>'
            : '') +
        '</div>' +
      '</div>';
  }

  async function load() {
    var body = $('leaderboard-body');
    if (body) {
      body.innerHTML = '<tr><td colspan="5" class="px-4 py-3">' +
        '<div class="skeleton h-5 w-full"></div></td></tr>';
    }

    var results = await Promise.allSettled([
      api.get('/api/leaderboard/' + metric, { limit: 25 }, { allowUnauthorized: true }),
      api.get('/api/leaderboard/rank/' + metric, null, { allowUnauthorized: true }),
    ]);

    if (results[0].status === 'fulfilled') {
      renderTable(results[0].value.leaderboard);
    } else if (body) {
      body.innerHTML = '<tr><td colspan="5">' +
        '<div class="empty-state">' +
          '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.6" stroke-linecap="round" class="text-ink-300" aria-hidden="true">' +
            '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>' +
          '<p class="empty-title">Could not load the leaderboard</p>' +
          '<p class="empty-text">The rankings service did not respond. Your runs are safe.</p>' +
          '<button type="button" class="btn-secondary mt-2" data-retry>Try again</button>' +
        '</div></td></tr>';
      var retry = body.querySelector('[data-retry]');
      if (retry) retry.addEventListener('click', load);
    }

    renderRank(results[1].status === 'fulfilled' ? results[1].value : null);
  }

  function setMetric(next) {
    if (metric === next) return;
    metric = next;
    document.querySelectorAll('[data-metric]').forEach(function (tab) {
      var on = tab.getAttribute('data-metric') === next;
      tab.classList.toggle('tab-active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    load();
  }

  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelectorAll('[data-metric]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        setMetric(tab.getAttribute('data-metric'));
      });
    });

    // Needed to highlight your own row. This page is viewable while signed
    // out, so a failure here is expected and non-fatal.
    try {
      var profile = await api.get('/api/auth/profile', null, { allowUnauthorized: true });
      myUsername = profile.user.username;
      var nav = $('nav-username');
      if (nav) { nav.textContent = myUsername; nav.classList.remove('hidden'); }
    } catch (e) {
      var logout = $('logout-btn');
      if (logout) logout.hidden = true;
    }

    await load();
    window.TRLoader.dataReady();
    window.TRLoader.ready();
  });
}(window));
