/**
 * One HTTP layer for the whole app.
 *
 * Previously getToken() was defined identically in three separate files and
 * logout() in two, every call built its own Authorization header by hand, and
 * only one of the three pages handled a 401 at all. axios is gone: fetch does
 * everything needed here without a 30 KB dependency.
 *
 * Auth now travels in an httpOnly cookie set by POST /api/auth/session, so
 * `credentials: 'same-origin'` is all that is required — the token is no
 * longer reachable from JavaScript, which is the point.
 */
(function (window) {
  'use strict';

  var JSON_HEADERS = { 'Content-Type': 'application/json' };

  function onUnauthorized() {
    // Clear any stale Supabase session so the login page starts clean.
    try { window.localStorage.removeItem('tr-session'); } catch (e) { /* private mode */ }
    if (!/\/login/.test(window.location.pathname)) {
      window.location.href = '/login?expired=1';
    }
  }

  async function request(method, url, body, options) {
    options = options || {};

    var init = {
      method: method,
      credentials: 'same-origin',
      headers: Object.assign({}, body ? JSON_HEADERS : {}, options.headers || {}),
    };
    if (body !== undefined && body !== null) init.body = JSON.stringify(body);
    if (options.signal) init.signal = options.signal;

    var res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Network-level failure: offline, DNS, or an aborted request.
      if (err.name === 'AbortError') throw err;
      var netErr = new Error('Network unavailable');
      netErr.offline = true;
      throw netErr;
    }

    if (res.status === 401 && !options.allowUnauthorized) {
      onUnauthorized();
      throw new Error('Not signed in');
    }

    var data = null;
    if (res.status !== 204) {
      var text = await res.text();
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      }
    }

    if (!res.ok) {
      var error = new Error((data && data.message) || ('Request failed (' + res.status + ')'));
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null && v !== '') {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
      }
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  var api = {
    get: function (url, params, options) { return request('GET', url + qs(params), null, options); },
    post: function (url, body, options) { return request('POST', url, body, options); },
    patch: function (url, body, options) { return request('PATCH', url, body, options); },

    /** Minutes west of UTC, so the server can record the runner's local day. */
    tzOffset: function () { return new Date().getTimezoneOffset(); },

    logout: async function () {
      try { await request('POST', '/api/auth/logout', {}, { allowUnauthorized: true }); } catch (e) { /* proceed anyway */ }
      if (window.TRAuth && window.TRAuth.signOut) {
        try { await window.TRAuth.signOut(); } catch (e) { /* proceed anyway */ }
      }
      window.location.href = '/login';
    },

    /**
     * Fire-and-forget delivery that survives the page being closed — used to
     * flush the last GPS buffer on pagehide, where a normal fetch would be
     * cancelled mid-flight.
     */
    beacon: function (url, body) {
      try {
        if (navigator.sendBeacon) {
          var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
          return navigator.sendBeacon(url, blob);
        }
      } catch (e) { /* fall through */ }
      try {
        fetch(url, {
          method: 'POST', credentials: 'same-origin', headers: JSON_HEADERS,
          body: JSON.stringify(body), keepalive: true,
        });
        return true;
      } catch (e) { return false; }
    },
  };

  window.TRApi = api;

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('logout-btn');
    if (btn) btn.addEventListener('click', function () { api.logout(); });
  });
}(window));
