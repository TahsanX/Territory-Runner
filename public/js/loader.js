/**
 * Advance the loader on REAL milestones.
 *
 *   33%  Ready — document parsed
 *   66%  Set   — stylesheet and scripts in
 *  100%  Go    — page data fetched
 *
 * A loader driven by a timer is a lie: it either finishes before the page is
 * usable or keeps spinning after it is. Pages call TRLoader.dataReady() and
 * TRLoader.ready() as their own work completes.
 */
(function (window) {
  'use strict';

  var STAGES = [
    { pct: 33,  caption: 'Ready' },
    { pct: 66,  caption: 'Set' },
    { pct: 100, caption: 'Go!' }
  ];

  // Hard ceiling. Whatever is still pending, the UI is never held hostage by
  // the loading screen.
  var MAX_MS = 3000;

  var current = -1;
  var done = false;
  var started = Date.now();
  var timer = null;

  function el(id) { return document.getElementById(id); }

  function paint(index) {
    var stage = STAGES[index];
    var root = el('tr-loader');
    if (!stage || !root) return;

    var bar = el('tr-loader-bar');
    if (bar) bar.style.width = stage.pct + '%';

    var track = root.querySelector('[role="progressbar"]');
    if (track) track.setAttribute('aria-valuenow', String(stage.pct));

    var caption = el('tr-loader-caption');
    if (caption && caption.textContent !== stage.caption) {
      caption.textContent = stage.caption;
      // Restart the pop so each word lands visibly.
      caption.classList.remove('is-pop');
      void caption.offsetWidth;
      caption.classList.add('is-pop');
    }
  }

  function stage(index) {
    if (done) return;
    // Monotonic: a late-arriving earlier milestone must not rewind the bar.
    if (index <= current) return;
    current = index;
    paint(index);
    if (index >= STAGES.length - 1) finish();
  }

  function finish() {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);

    paint(STAGES.length - 1);

    var root = el('tr-loader');
    if (!root) return;

    // Long enough for "Go!" to register, short enough not to feel like a delay.
    var hold = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 380;
    setTimeout(function () {
      root.classList.add('is-done');
      setTimeout(function () { root.hidden = true; }, 340);
    }, hold);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!el('tr-loader')) return;
    stage(0);
    window.addEventListener('load', function () { stage(1); });
    timer = setTimeout(finish, MAX_MS - (Date.now() - started));
  });

  window.TRLoader = {
    stage: stage,
    dataReady: function () { stage(2); },
    ready: finish
  };
}(window));
