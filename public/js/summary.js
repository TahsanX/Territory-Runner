/**
 * Monthly and yearly summary.
 *
 * Charts are hand-rolled inline SVG rather than a charting library: this page
 * needs one bar chart and one diverging bar, and Chart.js would be ~200 KB for
 * that — against the performance goals for the rest of the rewrite.
 */
(function (window) {
  'use strict';

  var api = window.TRApi;
  var ui = window.TRUi;
  var fmt = ui.fmt;

  var state = { period: 'month', year: 0, month: 0 };

  function $(id) { return document.getElementById(id); }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function statCard(label, value, note, tone) {
    var toneClass = tone === 'up' ? 'text-success' : tone === 'down' ? 'text-danger' : 'text-ink-900';
    return '<div class="stat">' +
      '<p class="stat-label">' + label + '</p>' +
      '<p class="stat-value ' + toneClass + '">' + value + '</p>' +
      (note ? '<p class="mt-0.5 text-xs text-ink-500">' + note + '</p>' : '') +
    '</div>';
  }

  /** Distance per bucket. Bars, because the comparison is between discrete periods. */
  function barChart(series, period) {
    if (!series.length) {
      return '<div class="empty-state"><p class="empty-text">No activity in this period.</p></div>';
    }

    var max = Math.max.apply(null, series.map(function (s) { return s.distanceKm; }));
    if (max <= 0) {
      return '<div class="empty-state"><p class="empty-text">No distance recorded.</p></div>';
    }

    var w = 100 / series.length;
    var bars = series.map(function (s, i) {
      var h = (s.distanceKm / max) * 100;
      var label = period === 'year'
        ? MONTHS[Number(s.bucket.split('-')[1]) - 1]
        : s.bucket;
      var title = label + ': ' + fmt.distance(s.distanceKm) +
                  (s.runs ? ' over ' + s.runs + (s.runs === 1 ? ' run' : ' runs') : '');

      // Keep a 1-unit floor so a day with a tiny run is still visible.
      return '<g><title>' + ui.escapeHtml(title) + '</title>' +
        '<rect x="' + (i * w + w * 0.15) + '" y="' + (100 - Math.max(h, 1)) + '" ' +
              'width="' + (w * 0.7) + '" height="' + Math.max(h, 1) + '" ' +
              'rx="0.6" fill="#2f7df5" fill-opacity="' + (0.35 + 0.55 * (h / 100)) + '"/>' +
      '</g>';
    }).join('');

    return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" ' +
                'class="h-32 w-full" role="img" ' +
                'aria-label="Distance per ' + (period === 'year' ? 'month' : 'day') + '">' +
             bars +
           '</svg>' +
           '<div class="mt-1 flex justify-between text-[0.65rem] text-ink-400">' +
             '<span>' + (period === 'year' ? MONTHS[Number(series[0].bucket.split('-')[1]) - 1] : series[0].bucket) + '</span>' +
             '<span class="numeric">peak ' + fmt.distance(max) + '</span>' +
           '</div>';
  }

  /**
   * Area gained against area lost, as a diverging bar.
   *
   * This is the chart that makes the stealing mechanic legible: it shows at a
   * glance whether you are net gaining or net losing ground.
   */
  function territoryChart(totals) {
    var gained = totals.areaGainedM2;
    var lost = totals.areaLostM2;
    var span = Math.max(gained, lost, 1);
    var gPct = (gained / span) * 100;
    var lPct = (lost / span) * 100;

    return '<div class="space-y-3">' +
      '<div>' +
        '<div class="mb-1 flex justify-between text-xs">' +
          '<span class="font-medium text-own">Captured</span>' +
          '<span class="numeric text-ink-700">' + fmt.area(gained) + '</span>' +
        '</div>' +
        '<div class="h-2.5 overflow-hidden rounded-full bg-ink-100">' +
          '<div class="h-full rounded-full bg-own" style="width:' + gPct + '%"></div>' +
        '</div>' +
      '</div>' +
      '<div>' +
        '<div class="mb-1 flex justify-between text-xs">' +
          '<span class="font-medium text-rival">Lost to rivals</span>' +
          '<span class="numeric text-ink-700">' + fmt.area(lost) + '</span>' +
        '</div>' +
        '<div class="h-2.5 overflow-hidden rounded-full bg-ink-100">' +
          '<div class="h-full rounded-full bg-rival" style="width:' + lPct + '%"></div>' +
        '</div>' +
      '</div>' +
      '<p class="border-t border-ink-100 pt-2 text-sm">' +
        '<span class="text-ink-500">Net: </span>' +
        '<span class="numeric font-semibold ' +
          (totals.netAreaM2 >= 0 ? 'text-success' : 'text-danger') + '">' +
          (totals.netAreaM2 >= 0 ? '+' : '−') + fmt.area(Math.abs(totals.netAreaM2)) +
        '</span>' +
      '</p>' +
    '</div>';
  }

  function placesList(places) {
    if (!places.length) {
      return '<div class="empty-state">' +
        '<p class="empty-title">No places recorded</p>' +
        '<p class="empty-text">Place names are looked up when a run finishes. ' +
        'They will appear here after your next few runs.</p></div>';
    }

    var max = places[0].visits;
    return '<ul class="divide-rows">' + places.map(function (p, i) {
      return '<li class="flex items-center gap-3 px-4 py-2.5 sm:px-5">' +
        '<span class="numeric w-5 text-xs font-semibold text-ink-400">' + (i + 1) + '</span>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="truncate text-sm font-medium text-ink-800">' + ui.escapeHtml(p.locality) + '</p>' +
          '<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">' +
            '<div class="h-full rounded-full bg-accent-500" ' +
                 'style="width:' + ((p.visits / max) * 100) + '%"></div>' +
          '</div>' +
        '</div>' +
        '<div class="shrink-0 text-right">' +
          '<p class="numeric text-sm font-medium text-ink-700">' + p.visits + '</p>' +
          '<p class="numeric text-[0.65rem] text-ink-400">' + fmt.distance(p.distanceKm) + '</p>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function render(d) {
    var t = d.totals;

    $('summary-title').textContent = d.period === 'year'
      ? String(d.year)
      : MONTHS[d.month - 1] + ' ' + d.year;

    $('summary-stats').innerHTML =
      statCard('Distance', fmt.distance(t.distanceKm), t.runs + (t.runs === 1 ? ' run' : ' runs')) +
      statCard('Calories', fmt.number(t.calories), 'burned') +
      statCard('Active days', String(t.activeDays), 'with a recorded run') +
      statCard('Time', fmt.duration(t.movingSeconds), 'moving');

    $('summary-territory').innerHTML = territoryChart(t);

    $('summary-streak').innerHTML =
      '<div class="grid grid-cols-3 gap-3 text-center">' +
        '<div><p class="stat-label">In this ' + d.period + '</p>' +
          '<p class="numeric text-stat text-own">' + d.streak.longestInPeriod + '</p>' +
          '<p class="text-xs text-ink-500">longest streak</p></div>' +
        '<div><p class="stat-label">Current</p>' +
          '<p class="numeric text-stat text-ink-900">' + d.streak.current + '</p>' +
          '<p class="text-xs text-ink-500">days running</p></div>' +
        '<div><p class="stat-label">All time</p>' +
          '<p class="numeric text-stat text-ink-900">' + d.streak.longestAllTime + '</p>' +
          '<p class="text-xs text-ink-500">personal best</p></div>' +
      '</div>';

    var ranks = '';
    if (d.ranks.area) {
      ranks += '<div class="stat"><p class="stat-label">Territory rank</p>' +
        '<p class="stat-value text-accent-700">' + fmt.ordinal(d.ranks.area.rank) + '</p>' +
        '<p class="mt-0.5 text-xs text-ink-500">of ' + d.ranks.area.total +
        ' · ' + fmt.area(d.ranks.area.value) + '</p></div>';
    }
    if (d.ranks.distance) {
      ranks += '<div class="stat"><p class="stat-label">Distance rank</p>' +
        '<p class="stat-value text-accent-700">' + fmt.ordinal(d.ranks.distance.rank) + '</p>' +
        '<p class="mt-0.5 text-xs text-ink-500">of ' + d.ranks.distance.total +
        ' · ' + fmt.distance(d.ranks.distance.value) + '</p></div>';
    }
    $('summary-ranks').innerHTML = ranks ||
      '<p class="px-1 text-sm text-ink-500">Rankings appear once you have recorded a run.</p>';

    $('summary-places').innerHTML = placesList(d.places);
    $('summary-chart').innerHTML = barChart(d.series, d.period);

    var b = d.territoryBattles;
    $('summary-battles').innerHTML =
      '<div class="grid grid-cols-2 gap-3">' +
        statCard('Territories taken', String(b.won.events),
                 fmt.area(b.won.areaM2) + ' gained', 'up') +
        statCard('Territories lost', String(b.lost.events),
                 b.lost.rivals + (b.lost.rivals === 1 ? ' rival' : ' rivals') +
                 ' · ' + fmt.area(b.lost.areaM2), 'down') +
      '</div>';

    var best = $('summary-best');
    if (d.bestRun) {
      best.innerHTML =
        '<p class="stat-label">Best single run</p>' +
        '<p class="mt-1 text-stat numeric text-ink-900">' + fmt.distance(d.bestRun.distanceKm) + '</p>' +
        '<p class="mt-1 text-sm text-ink-600">' +
          fmt.duration(d.bestRun.timeSeconds) + ' · ' +
          fmt.pace(d.bestRun.distanceKm, d.bestRun.timeSeconds) +
          (d.bestRun.locality ? ' · ' + ui.escapeHtml(d.bestRun.locality) : '') +
        '</p>' +
        '<p class="mt-0.5 text-xs text-ink-400">' + fmt.date(d.bestRun.date) + '</p>';
      best.hidden = false;
    } else {
      best.hidden = true;
    }
  }

  async function load() {
    var root = $('summary-root');
    root.setAttribute('aria-busy', 'true');
    try {
      var d = await api.get('/api/stats/summary', {
        period: state.period,
        year: state.year,
        month: state.month,
        tzOffset: api.tzOffset(),
      });
      render(d);
    } catch (err) {
      ui.toast(err.message || 'Could not load the summary.', 'error');
    } finally {
      root.setAttribute('aria-busy', 'false');
    }
  }

  function shift(delta) {
    if (state.period === 'year') {
      state.year += delta;
    } else {
      var m = state.month + delta;
      if (m < 1) { m = 12; state.year -= 1; }
      if (m > 12) { m = 1; state.year += 1; }
      state.month = m;
    }
    load();
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth() + 1;

    document.querySelectorAll('[data-period]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var next = tab.getAttribute('data-period');
        if (state.period === next) return;
        state.period = next;
        document.querySelectorAll('[data-period]').forEach(function (t) {
          var on = t.getAttribute('data-period') === next;
          t.classList.toggle('tab-active', on);
          t.setAttribute('aria-selected', String(on));
        });
        load();
      });
    });

    $('period-prev').addEventListener('click', function () { shift(-1); });
    $('period-next').addEventListener('click', function () { shift(1); });

    try {
      var profile = await api.get('/api/auth/profile');
      var nav = $('nav-username');
      if (nav) { nav.textContent = profile.user.username; nav.classList.remove('hidden'); }
    } catch (e) { /* the page guard already handles a missing session */ }

    await load();
    window.TRLoader.dataReady();
    window.TRLoader.ready();
  });
}(window));
