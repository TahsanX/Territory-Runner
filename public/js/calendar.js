/**
 * Streak calendar.
 *
 * A day with more distance gets a deeper, bolder cell; a short run gets a
 * light, thin one; a rest day stays empty. Intensity is carried by fill depth
 * AND border weight together, so it survives a colour-vision deficiency and a
 * greyscale print — colour alone would not.
 *
 * Buckets come from the quantiles of this user's own history (computed in
 * models/DailyActivity.js), not fixed thresholds, so the scale stays
 * meaningful whether their normal run is 2 km or 20 km.
 */
(function (window) {
  'use strict';

  var fmt = window.TRUi.fmt;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function Calendar(rootId, options) {
    this.root = document.getElementById(rootId);
    this.opts = options || {};
    var now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth() + 1;
    this.data = null;
  }

  Calendar.prototype.load = async function () {
    if (!this.root) return;
    this.renderSkeleton();
    try {
      this.data = await window.TRApi.get('/api/stats/calendar', {
        year: this.year, month: this.month, tzOffset: window.TRApi.tzOffset(),
      });
      this.render();
    } catch (err) {
      this.root.innerHTML =
        '<div class="empty-state"><p class="empty-title">Calendar unavailable</p>' +
        '<p class="empty-text">' + window.TRUi.escapeHtml(err.message) + '</p></div>';
    }
  };

  Calendar.prototype.shift = function (delta) {
    var m = this.month + delta;
    var y = this.year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    this.month = m;
    this.year = y;
    this.load();
  };

  Calendar.prototype.renderSkeleton = function () {
    var cells = '';
    for (var i = 0; i < 35; i++) cells += '<div class="skeleton aspect-square"></div>';
    this.root.innerHTML = '<div class="cal-grid">' + cells + '</div>';
  };

  Calendar.prototype.render = function () {
    var d = this.data;
    var self = this;

    var head =
      '<div class="mb-3 flex items-center justify-between gap-2">' +
        '<button type="button" class="btn-ghost px-2 py-1" data-cal="prev" aria-label="Previous month">' +
          '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M12 4l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '<span class="text-sm font-semibold text-ink-800">' +
          MONTHS[d.month - 1] + ' ' + d.year +
        '</span>' +
        '<button type="button" class="btn-ghost px-2 py-1" data-cal="next" aria-label="Next month">' +
          '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M8 4l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
      '</div>';

    var grid = '<div class="cal-grid" role="grid" aria-label="Running streak calendar">';
    DOW.forEach(function (name) {
      grid += '<div class="cal-dow" role="columnheader">' + name + '</div>';
    });

    // Leading blanks so the 1st lands under the right weekday.
    var lead = d.days.length ? d.days[0].weekday : 0;
    for (var i = 0; i < lead; i++) grid += '<div class="cal-empty" aria-hidden="true"></div>';

    d.days.forEach(function (day) {
      var classes = ['cal-day', 'cal-' + day.intensity];
      if (day.isToday) classes.push('cal-today');
      if (day.isFuture) classes.push('cal-future');

      // The title carries the real numbers, so intensity never has to be
      // guessed from the shade alone.
      var label = day.runs > 0
        ? fmt.date(day.date) + ': ' + fmt.distance(day.distanceKm) +
          ', ' + day.runs + (day.runs === 1 ? ' run' : ' runs') +
          (day.areaGainedM2 > 0 ? ', +' + fmt.area(day.areaGainedM2) : '') +
          (day.areaLostM2 > 0 ? ', -' + fmt.area(day.areaLostM2) : '')
        : fmt.date(day.date) + ': rest day';

      grid += '<div class="' + classes.join(' ') + '" role="gridcell" ' +
              'title="' + window.TRUi.escapeHtml(label) + '" ' +
              'aria-label="' + window.TRUi.escapeHtml(label) + '">' +
              day.day + '</div>';
    });
    grid += '</div>';

    var s = d.streak;
    var foot =
      '<div class="mt-4 grid grid-cols-3 gap-2 border-t border-ink-100 pt-3 text-center">' +
        miniStat('Current', s.current + (s.current === 1 ? ' day' : ' days')) +
        miniStat('This month', s.longestThisMonth + (s.longestThisMonth === 1 ? ' day' : ' days')) +
        miniStat('Best ever', s.longest + (s.longest === 1 ? ' day' : ' days')) +
      '</div>' +
      '<div class="mt-3 flex items-center justify-end gap-1.5 text-[0.65rem] text-ink-400">' +
        '<span>Less</span>' +
        '<span class="cal-day cal-0 !h-3.5 !w-3.5 !aspect-auto"></span>' +
        '<span class="cal-day cal-1 !h-3.5 !w-3.5 !aspect-auto"></span>' +
        '<span class="cal-day cal-2 !h-3.5 !w-3.5 !aspect-auto"></span>' +
        '<span class="cal-day cal-3 !h-3.5 !w-3.5 !aspect-auto"></span>' +
        '<span class="cal-day cal-4 !h-3.5 !w-3.5 !aspect-auto"></span>' +
        '<span>More</span>' +
      '</div>';

    // Be explicit while the quantiles are still bootstrapped, so the shading
    // isn't mistaken for a verdict on only three days of data.
    if (d.thresholds.bootstrapped) {
      foot += '<p class="mt-2 text-center text-[0.65rem] text-ink-400">' +
              'Shading uses default thresholds until you have a few more runs.</p>';
    }

    this.root.innerHTML = head + grid + foot;

    this.root.querySelectorAll('[data-cal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        self.shift(btn.getAttribute('data-cal') === 'next' ? 1 : -1);
      });
    });

    if (this.opts.onLoad) this.opts.onLoad(d);
  };

  function miniStat(label, value) {
    return '<div><p class="stat-label">' + label + '</p>' +
           '<p class="numeric text-sm font-semibold text-ink-900">' + value + '</p></div>';
  }

  window.TRCalendar = Calendar;
}(window));
