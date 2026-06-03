/**
 * Toasts and shared formatters.
 *
 * Replaces the three raw alert() calls on the run page, which blocked the
 * whole tab mid-run — including the GPS watch callback.
 */
(function (window) {
  'use strict';

  var ICONS = {
    success: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="mt-0.5 shrink-0 text-success"><path d="M4 10.5l4 4 8-9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:   '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="mt-0.5 shrink-0 text-danger"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v5M10 14h.01" stroke-linecap="round"/></svg>',
    info:    '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="mt-0.5 shrink-0 text-accent-500"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.5M10 6.5h.01" stroke-linecap="round"/></svg>'
  };

  function toast(message, type, ms) {
    type = type || 'info';
    var stack = document.getElementById('toast-stack');
    if (!stack) { console.log('[' + type + '] ' + message); return; }

    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = (ICONS[type] || ICONS.info) +
      '<span class="flex-1 text-ink-700"></span>';
    el.querySelector('span').textContent = message;
    stack.appendChild(el);

    var life = ms || (type === 'error' ? 6000 : 3600);
    setTimeout(function () {
      el.style.transition = 'opacity .2s ease, transform .2s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () { el.remove(); }, 220);
    }, life);
  }

  var fmt = {
    /** Square metres read badly above a hectare; switch units by magnitude. */
    area: function (m2) {
      var v = Number(m2) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(2) + ' km²';
      if (v >= 10000) return (v / 10000).toFixed(2) + ' ha';
      return Math.round(v).toLocaleString() + ' m²';
    },

    distance: function (km) {
      var v = Number(km) || 0;
      if (v < 1) return Math.round(v * 1000) + ' m';
      return v.toFixed(2) + ' km';
    },

    duration: function (seconds) {
      var s = Math.max(0, Math.floor(Number(seconds) || 0));
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      function pad(n) { return String(n).padStart(2, '0'); }
      return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec);
    },

    /** Pace is what runners actually judge a run by; the old UI never showed it. */
    pace: function (km, seconds) {
      var d = Number(km) || 0;
      var t = Number(seconds) || 0;
      if (d < 0.05 || t <= 0) return '—';
      var secPerKm = t / d;
      if (secPerKm > 3600) return '—';
      var m = Math.floor(secPerKm / 60);
      var s = Math.round(secPerKm % 60);
      if (s === 60) { m += 1; s = 0; }
      return m + ':' + String(s).padStart(2, '0') + ' /km';
    },

    date: function (value, opts) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleDateString(undefined,
          opts || { day: 'numeric', month: 'short', year: 'numeric' });
      } catch (e) { return String(value); }
    },

    dateTime: function (value) {
      if (!value) return '—';
      try {
        return new Date(value).toLocaleString(undefined,
          { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      } catch (e) { return String(value); }
    },

    number: function (n) { return (Number(n) || 0).toLocaleString(); },

    ordinal: function (n) {
      var v = Number(n) || 0;
      var s = ['th', 'st', 'nd', 'rd'];
      var r = v % 100;
      return v + (s[(r - 20) % 10] || s[r] || s[0]);
    }
  };

  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.TRUi = { toast: toast, fmt: fmt, escapeHtml: escapeHtml };
}(window));
